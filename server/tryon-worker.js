// Miraal try-on server (Cloudflare Worker).
//
// The website cannot hold the fal.ai key (anyone could read it), so this small server holds it.
// It does three things, and stores nothing except a daily counter:
//   1. Outfit try-on: the site sends a visitor's photo and an outfit picture; fal.ai puts the outfit
//      on the person and this server sends back the picture's web address.
//   2. Unstitched fabric: the site sends a fabric picture and stitching choices; fal.ai first makes
//      a picture of the stitched suit, then puts that suit on the person.
//   3. Picture links: fetches a fabric picture from a shop's website when the shop does not let the
//      visitor's browser read it directly (GET ?img=<link>).
//
// Settings (Cloudflare dashboard → Worker → Settings → Variables and Secrets):
//   FAL_KEY          secret   your fal.ai key (required)
//   ALLOWED_ORIGINS  text     site addresses allowed to use this server, comma separated
//                             default: https://splicendicemedia-editing.github.io
//   FAL_MODEL        text     try-on model, default: fal-ai/fashn/tryon/v1.6
//                             also supported: fal-ai/kling/v1-5/kolors-virtual-try-on
//                                             fal-ai/image-apps-v2/virtual-try-on
//   FAL_EDIT_MODEL   text     model that stitches a suit from fabric, default: fal-ai/nano-banana/edit
//   DAILY_LIMIT      text     real try-ons per visitor per day, default 5
// Optional KV namespace bound as LIMITS: needed for the per-visitor daily limit to be enforced here.
//
// Problem log (optional):
//   D1 database bound as DB   the site sends a short text note when something goes wrong for a visitor
//                             (never a picture); the notes are kept here for 60 days
//   ADMIN_KEY        secret   the owner's private code for reading the notes on problems.html
//                             (at least 8 characters; without it the notes are stored but cannot be read)

const DEFAULT_ORIGINS = 'https://splicendicemedia-editing.github.io';
const DEFAULT_MODEL = 'fal-ai/fashn/tryon/v1.6';
const DEFAULT_EDIT_MODEL = 'fal-ai/nano-banana/edit';
const MAX_PHOTO_CHARS = 3_500_000;  // about 2.6 MB of JPEG as base64
const MAX_FABRIC_CHARS = 1_600_000; // about 1.2 MB
const MAX_PROXY_BYTES = 8_000_000;
const MAX_PROBLEMS_A_DAY = 2000;

// how each fal try-on model wants its input, and where its answer keeps the picture
const MODELS = {
  'fal-ai/fashn/tryon/v1.6': {
    input: (person, garment, onModel) => ({ model_image: person, garment_image: garment, category: 'auto', garment_photo_type: onModel ? 'model' : 'auto', mode: 'balanced', output_format: 'jpeg', num_samples: 1 }),
    output: (d) => d?.images?.[0]?.url,
  },
  'fal-ai/kling/v1-5/kolors-virtual-try-on': {
    input: (person, garment) => ({ human_image_url: person, garment_image_url: garment }),
    output: (d) => d?.image?.url,
  },
  'fal-ai/image-apps-v2/virtual-try-on': {
    input: (person, garment) => ({ person_image_url: person, clothing_image_url: garment, preserve_pose: true }),
    output: (d) => d?.images?.[0]?.url,
  },
};

// stitching choices: fixed lists, so nothing a visitor types ever reaches the AI
const NECK = {
  gol: 'a round collarless neckline (gol gala) with a short concealed front opening',
  ban: 'a band collar (mandarin collar) with a short buttoned front placket',
  shirt: 'a classic pointed shirt collar with a buttoned front placket',
  v: 'a collarless V-neckline',
};
const BOTTOM = {
  shalwar: 'a traditional loose shalwar, gathered narrow at the ankles',
  khuli: 'a wide straight shalwar with an open, ungathered hem (khuli shalwar)',
  kali: 'a very full panelled shalwar with many pleats (kali wali shalwar), gathered at the ankles',
  pajama: 'a slim straight pajama',
  trouser: 'straight-cut trousers',
};
function stitchPrompt(stitch) {
  const men = stitch.wearer === 'men';
  return [
    `A catalogue photo of one ${men ? "men's" : "women's"} Pakistani shalwar kameez suit, stitched entirely from the fabric shown in the reference picture.`,
    'Keep the fabric exactly as it is: the same colours, the same print or weave, the same scale of pattern.',
    `The kameez is ${men ? 'straight-cut and knee length' : 'knee length with side slits and a gently shaped waist'}, with full-length sleeves and ${NECK[stitch.neck]}.`,
    `It is worn with ${BOTTOM[stitch.bottom]}${men ? ' in the same fabric' : ' in a plain colour that matches the fabric'}.`,
    'Show the complete suit on a plain headless mannequin, front view, full length from the neck to the ankles, centred, on a plain light grey studio background with soft even light.',
    'No person, no face, no hands, no text, no logos, no extra garments.',
  ].join(' ');
}

/* ---------- problem log ---------- */
const clip = (v, n) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, n) : '');
let tableReady = false;
async function ensureTable(env) {
  if (tableReady) return;
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS problems (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL, msg TEXT, place TEXT, ver TEXT, device TEXT, net TEXT, isp TEXT, country TEXT, visitor TEXT, client_at TEXT, extra TEXT)').run();
  tableReady = true;
}
// keep up to 10 notes from one request; returns how many were stored
async function saveProblems(env, request, list) {
  const now = new Date(), at = now.toISOString(), day = at.slice(0, 10);
  const cf = request.cf || {};
  const rows = list.slice(0, 10).map((r) => {
    if (!r || typeof r !== 'object' || !/^[a-z0-9_.-]{2,40}$/.test(r.kind || '')) return null;
    const t = Number(r.t);
    return {
      kind: r.kind, msg: clip(r.msg, 300), place: clip(r.place, 40), ver: clip(r.ver, 10),
      device: clip(r.device, 80) || clip(request.headers.get('User-Agent') || '', 80), net: clip(r.net, 20),
      isp: clip(cf.asOrganization || '', 60), country: clip(cf.country || '', 4),
      visitor: /^[0-9a-f]{12}$/.test(r.visitor || '') ? r.visitor : '',
      client_at: t > 1.7e12 && t < now.getTime() + 864e5 ? new Date(t).toISOString() : '', extra: clip(r.extra, 200),
    };
  }).filter(Boolean);
  for (const r of rows) console.warn('problem', JSON.stringify(r)); // also shows in the Worker's own log
  if (!env.DB || !rows.length) return 0;
  await ensureTable(env);
  const today = await env.DB.prepare('SELECT COUNT(*) AS n FROM problems WHERE day = ?').bind(day).first();
  if (((today && today.n) || 0) >= MAX_PROBLEMS_A_DAY) return 0;
  const add = env.DB.prepare('INSERT INTO problems (at, day, kind, msg, place, ver, device, net, isp, country, visitor, client_at, extra) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  await env.DB.batch(rows.map((r) => add.bind(at, day, r.kind, r.msg, r.place, r.ver, r.device, r.net, r.isp, r.country, r.visitor, r.client_at, r.extra)));
  if (Math.random() < 0.02) await env.DB.prepare('DELETE FROM problems WHERE day < ?').bind(new Date(now.getTime() - 60 * 864e5).toISOString().slice(0, 10)).run();
  return rows.length;
}
async function sameSecret(a, b) {
  const h = async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  const [x, y] = await Promise.all([h(a), h(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
// the owner's private list: [body, status]
async function readProblems(env, request) {
  if (!env.DB || typeof env.ADMIN_KEY !== 'string' || env.ADMIN_KEY.length < 8) return [{ error: 'The problems page is not set up yet' }, 503];
  const given = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!given || !(await sameSecret(given, env.ADMIN_KEY))) { await new Promise((r) => setTimeout(r, 700)); return [{ error: 'Wrong code' }, 401]; }
  await ensureTable(env);
  const now = new Date(), since = new Date(now.getTime() - 6 * 864e5).toISOString().slice(0, 10);
  const rows = (await env.DB.prepare('SELECT id, at, kind, msg, place, ver, device, net, isp, country, visitor, client_at, extra FROM problems ORDER BY id DESC LIMIT 300').all()).results;
  const byKind = (await env.DB.prepare('SELECT kind, COUNT(*) AS n, COUNT(DISTINCT visitor) AS people FROM problems WHERE day >= ? GROUP BY kind ORDER BY n DESC').bind(since).all()).results;
  return [{ rows, byKind, now: now.toISOString() }, 200];
}

const isFalMedia = (h) => h === 'fal.media' || h.endsWith('.fal.media') || h === 'cdn.fashn.ai';

async function visitorKey(request) {
  // never store the raw address: keep only a one-way fingerprint for today
  const day = new Date().toISOString().slice(0, 10);
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${day}|${ip}`));
  return `${day}:${[...new Uint8Array(bytes)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

async function fal(env, modelId, input) {
  const res = await fetch(`https://fal.run/${modelId}`, {
    method: 'POST',
    headers: { Authorization: `Key ${env.FAL_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => null) };
}

export default {
  async fetch(request, env, ctx) {
    const allowed = (env.ALLOWED_ORIGINS || DEFAULT_ORIGINS).split(',').map((s) => s.trim()).filter(Boolean);
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0],
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST' && request.method !== 'GET') return json({ error: 'Use POST' }, 405);
    if (!allowed.includes(origin)) return json({ error: 'This site is not allowed to use the try-on server' }, 403);

    /* 3. fetch a fabric picture from a shop link */
    if (request.method === 'GET') {
      if (new URL(request.url).searchParams.has('problems')) {
        const [out, status] = await readProblems(env, request).catch(() => [{ error: 'The problem log could not be read' }, 500]);
        return new Response(JSON.stringify(out), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
      }
      let target;
      try { target = new URL(new URL(request.url).searchParams.get('img')); } catch { return json({ error: 'Use POST' }, 405); }
      if (target.protocol !== 'https:') return json({ error: 'Only https picture links work' }, 400);
      let pic;
      try { pic = await fetch(target.href, { headers: { Accept: 'image/*' }, redirect: 'follow' }); } catch { return json({ error: 'That picture could not be fetched' }, 502); }
      const type = pic.headers.get('Content-Type') || '';
      const size = parseInt(pic.headers.get('Content-Length') || '0', 10);
      if (!pic.ok || !pic.body || !type.startsWith('image/') || size > MAX_PROXY_BYTES) return json({ error: 'That link is not a picture we can use' }, 400);
      // count the bytes while reading, because a site can leave out the size or give a wrong one
      const reader = pic.body.getReader(), chunks = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_PROXY_BYTES) { await reader.cancel().catch(() => {}); return json({ error: 'That picture is too large' }, 400); }
        chunks.push(value);
      }
      return new Response(new Blob(chunks), { status: 200, headers: { ...cors, 'Content-Type': type, 'Cache-Control': 'private, max-age=600' } });
    }

    let body;
    try { body = await request.json(); } catch { return json({ error: 'Bad request' }, 400); }

    /* 4. problem notes from the site */
    if (body && Array.isArray(body.reports)) return json({ stored: await saveProblems(env, request, body.reports).catch(() => 0) });
    // problems the server sees itself are noted too, without holding up the answer
    const note = (kind, msg, place) => { const job = saveProblems(env, request, [{ kind, msg, place, t: Date.now() }]).catch(() => 0); if (ctx && ctx.waitUntil) ctx.waitUntil(job); };

    if (!env.FAL_KEY) return json({ error: 'The try-on server has no fal.ai key yet' }, 503);
    const { person, garment, fabric, stitch } = body || {};
    if (typeof person !== 'string' || !person.startsWith('data:image/jpeg;base64,') || person.length > MAX_PHOTO_CHARS) return json({ error: 'The photo is missing or too large' }, 400);

    // what will be worn: a Miraal outfit picture, a suit this server stitched earlier, or a new fabric
    let garmentUrl = null, onModel = false, wantsStitch = false;
    if (typeof garment === 'string') {
      try { garmentUrl = new URL(garment); } catch { return json({ error: 'The outfit picture is missing' }, 400); }
      const host = garmentUrl.hostname;
      if (garmentUrl.protocol !== 'https:' || !(host === 'images.unsplash.com' || isFalMedia(host))) return json({ error: 'That outfit picture is not allowed' }, 400);
      onModel = host === 'images.unsplash.com';
    } else if (typeof fabric === 'string') {
      if (!fabric.startsWith('data:image/jpeg;base64,') || fabric.length > MAX_FABRIC_CHARS) return json({ error: 'The fabric picture is missing or too large' }, 400);
      if (!stitch || !['men', 'women'].includes(stitch.wearer) || !Object.hasOwn(NECK, stitch.neck) || !Object.hasOwn(BOTTOM, stitch.bottom)) return json({ error: 'The stitching choices are missing' }, 400);
      wantsStitch = true;
    } else return json({ error: 'The outfit picture is missing' }, 400);

    const limit = parseInt(env.DAILY_LIMIT || '5', 10) || 5;
    let key = null, usedToday = 0;
    if (env.LIMITS) {
      key = await visitorKey(request);
      usedToday = parseInt((await env.LIMITS.get(key)) || '0', 10) || 0;
      if (usedToday >= limit) { note('server.limit_reached', `limit ${limit} a day`, wantsStitch ? 'Fabric' : 'Outfit'); return json({ error: 'Daily limit reached', left: 0 }, 429); }
      // count this try-on before the slow AI work, so several requests sent at once cannot all slip under the limit
      await env.LIMITS.put(key, String(usedToday + 1), { expirationTtl: 172800 });
    }
    const left = key ? Math.max(0, limit - usedToday - 1) : null;
    // nothing was made: give the try-on back
    const refund = async () => { if (key) await env.LIMITS.put(key, String(usedToday), { expirationTtl: 172800 }).catch(() => {}); };

    let stitchedUrl = null;
    try {
      if (wantsStitch) {
        const made = await fal(env, env.FAL_EDIT_MODEL || DEFAULT_EDIT_MODEL, { prompt: stitchPrompt(stitch), image_urls: [fabric], num_images: 1, output_format: 'jpeg', aspect_ratio: '2:3' });
        stitchedUrl = made.ok ? made.data?.images?.[0]?.url : null;
        if (!stitchedUrl) { note('server.stitch_failed', `AI answered ${made.status}: ${clip(JSON.stringify(made.data), 200)}`, 'Fabric'); await refund(); return json({ error: 'The suit could not be stitched from this fabric picture', status: made.status }, 502); }
      }
      const modelId = MODELS[env.FAL_MODEL] ? env.FAL_MODEL : DEFAULT_MODEL;
      const model = MODELS[modelId];
      const worn = await fal(env, modelId, model.input(person, stitchedUrl || garmentUrl.href, onModel));
      const image = worn.ok ? model.output(worn.data) : null;
      if (!image) {
        note('server.ai_failed', `AI answered ${worn.status}: ${clip(JSON.stringify(worn.data), 200)}`, wantsStitch ? 'Fabric' : 'Outfit');
        // a suit that was stitched has been paid for, so it still counts; the site keeps it for the retry
        if (stitchedUrl) return json({ error: 'The try-on service could not make this picture', status: worn.status, garment: stitchedUrl, left }, 502);
        await refund();
        return json({ error: 'The try-on service could not make this picture', status: worn.status }, 502);
      }
      return json({ image, garment: stitchedUrl, left });
    } catch (e) {
      note('server.ai_unreachable', clip(String((e && e.message) || e), 200), wantsStitch ? 'Fabric' : 'Outfit');
      if (stitchedUrl) return json({ error: 'The try-on service could not be reached', garment: stitchedUrl, left }, 502);
      await refund();
      return json({ error: 'The try-on service could not be reached' }, 502);
    }
  },
};
