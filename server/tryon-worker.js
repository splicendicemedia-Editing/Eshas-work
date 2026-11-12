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

const DEFAULT_ORIGINS = 'https://splicendicemedia-editing.github.io';
const DEFAULT_MODEL = 'fal-ai/fashn/tryon/v1.6';
const DEFAULT_EDIT_MODEL = 'fal-ai/nano-banana/edit';
const MAX_PHOTO_CHARS = 3_500_000;  // about 2.6 MB of JPEG as base64
const MAX_FABRIC_CHARS = 1_600_000; // about 1.2 MB
const MAX_PROXY_BYTES = 8_000_000;

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
  async fetch(request, env) {
    const allowed = (env.ALLOWED_ORIGINS || DEFAULT_ORIGINS).split(',').map((s) => s.trim()).filter(Boolean);
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0],
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      Vary: 'Origin',
    };
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST' && request.method !== 'GET') return json({ error: 'Use POST' }, 405);
    if (!allowed.includes(origin)) return json({ error: 'This site is not allowed to use the try-on server' }, 403);

    /* 3. fetch a fabric picture from a shop link */
    if (request.method === 'GET') {
      let target;
      try { target = new URL(new URL(request.url).searchParams.get('img')); } catch { return json({ error: 'Use POST' }, 405); }
      if (target.protocol !== 'https:') return json({ error: 'Only https picture links work' }, 400);
      let pic;
      try { pic = await fetch(target.href, { headers: { Accept: 'image/*' }, redirect: 'follow' }); } catch { return json({ error: 'That picture could not be fetched' }, 502); }
      const type = pic.headers.get('Content-Type') || '';
      const size = parseInt(pic.headers.get('Content-Length') || '0', 10);
      if (!pic.ok || !type.startsWith('image/') || size > MAX_PROXY_BYTES) return json({ error: 'That link is not a picture we can use' }, 400);
      return new Response(pic.body, { status: 200, headers: { ...cors, 'Content-Type': type, 'Cache-Control': 'private, max-age=600' } });
    }

    if (!env.FAL_KEY) return json({ error: 'The try-on server has no fal.ai key yet' }, 503);
    let body;
    try { body = await request.json(); } catch { return json({ error: 'Bad request' }, 400); }
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
      if (!stitch || !['men', 'women'].includes(stitch.wearer) || !NECK[stitch.neck] || !BOTTOM[stitch.bottom]) return json({ error: 'The stitching choices are missing' }, 400);
      wantsStitch = true;
    } else return json({ error: 'The outfit picture is missing' }, 400);

    const limit = parseInt(env.DAILY_LIMIT || '5', 10) || 5;
    let key = null, usedToday = 0;
    if (env.LIMITS) {
      key = await visitorKey(request);
      usedToday = parseInt((await env.LIMITS.get(key)) || '0', 10) || 0;
      if (usedToday >= limit) return json({ error: 'Daily limit reached', left: 0 }, 429);
    }

    try {
      let stitchedUrl = null;
      if (wantsStitch) {
        const made = await fal(env, env.FAL_EDIT_MODEL || DEFAULT_EDIT_MODEL, { prompt: stitchPrompt(stitch), image_urls: [fabric], num_images: 1, output_format: 'jpeg', aspect_ratio: '2:3' });
        stitchedUrl = made.ok ? made.data?.images?.[0]?.url : null;
        if (!stitchedUrl) return json({ error: 'The suit could not be stitched from this fabric picture', status: made.status }, 502);
      }
      const modelId = MODELS[env.FAL_MODEL] ? env.FAL_MODEL : DEFAULT_MODEL;
      const model = MODELS[modelId];
      const worn = await fal(env, modelId, model.input(person, stitchedUrl || garmentUrl.href, onModel));
      const image = worn.ok ? model.output(worn.data) : null;
      if (!image) return json({ error: 'The try-on service could not make this picture', status: worn.status, garment: stitchedUrl }, 502);

      if (key) await env.LIMITS.put(key, String(usedToday + 1), { expirationTtl: 172800 });
      return json({ image, garment: stitchedUrl, left: key ? Math.max(0, limit - usedToday - 1) : null });
    } catch {
      return json({ error: 'The try-on service could not be reached' }, 502);
    }
  },
};
