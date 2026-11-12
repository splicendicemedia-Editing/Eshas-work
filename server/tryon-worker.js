// Miraal try-on server (Cloudflare Worker).
//
// The website cannot hold the fal.ai key (anyone could read it), so this small server holds it.
// The site sends a visitor's photo and the outfit picture here; this server asks fal.ai for the
// try-on picture and sends back its web address. Nothing is stored here except a daily counter.
//
// Settings (Cloudflare dashboard → Worker → Settings → Variables and Secrets):
//   FAL_KEY          secret   your fal.ai key (required)
//   ALLOWED_ORIGINS  text     site addresses allowed to use this server, comma separated
//                             default: https://splicendicemedia-editing.github.io
//   FAL_MODEL        text     default: fal-ai/fashn/tryon/v1.6
//                             also supported: fal-ai/kling/v1-5/kolors-virtual-try-on
//                                             fal-ai/image-apps-v2/virtual-try-on
//   DAILY_LIMIT      text     real try-ons per visitor per day, default 5
// Optional KV namespace bound as LIMITS: needed for the per-visitor daily limit to be enforced here.

const DEFAULT_ORIGINS = 'https://splicendicemedia-editing.github.io';
const DEFAULT_MODEL = 'fal-ai/fashn/tryon/v1.6';
const MAX_PHOTO_CHARS = 3_500_000; // about 2.6 MB of JPEG as base64

// how each fal model wants its input, and where its answer keeps the picture
const MODELS = {
  'fal-ai/fashn/tryon/v1.6': {
    input: (person, garment) => ({ model_image: person, garment_image: garment, category: 'auto', garment_photo_type: 'model', mode: 'balanced', output_format: 'jpeg', num_samples: 1 }),
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

async function visitorKey(request) {
  // never store the raw address: keep only a one-way fingerprint for today
  const day = new Date().toISOString().slice(0, 10);
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${day}|${ip}`));
  return `${day}:${[...new Uint8Array(bytes)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export default {
  async fetch(request, env) {
    const allowed = (env.ALLOWED_ORIGINS || DEFAULT_ORIGINS).split(',').map((s) => s.trim()).filter(Boolean);
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0],
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      Vary: 'Origin',
    };
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return json({ error: 'Use POST' }, 405);
    if (!allowed.includes(origin)) return json({ error: 'This site is not allowed to use the try-on server' }, 403);
    if (!env.FAL_KEY) return json({ error: 'The try-on server has no fal.ai key yet' }, 503);

    let body;
    try { body = await request.json(); } catch { return json({ error: 'Bad request' }, 400); }
    const { person, garment } = body || {};
    if (typeof person !== 'string' || !person.startsWith('data:image/jpeg;base64,') || person.length > MAX_PHOTO_CHARS) return json({ error: 'The photo is missing or too large' }, 400);
    let garmentUrl;
    try { garmentUrl = new URL(garment); } catch { return json({ error: 'The outfit picture is missing' }, 400); }
    // only Miraal's own outfit pictures (Unsplash image server) may be used
    if (garmentUrl.protocol !== 'https:' || garmentUrl.hostname !== 'images.unsplash.com') return json({ error: 'That outfit picture is not allowed' }, 400);

    const limit = parseInt(env.DAILY_LIMIT || '5', 10) || 5;
    let key = null, usedToday = 0;
    if (env.LIMITS) {
      key = await visitorKey(request);
      usedToday = parseInt((await env.LIMITS.get(key)) || '0', 10) || 0;
      if (usedToday >= limit) return json({ error: 'Daily limit reached', left: 0 }, 429);
    }

    const modelId = MODELS[env.FAL_MODEL] ? env.FAL_MODEL : DEFAULT_MODEL;
    const model = MODELS[modelId];
    let falRes, data;
    try {
      falRes = await fetch(`https://fal.run/${modelId}`, {
        method: 'POST',
        headers: { Authorization: `Key ${env.FAL_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(model.input(person, garmentUrl.href)),
      });
      data = await falRes.json().catch(() => null);
    } catch {
      return json({ error: 'The try-on service could not be reached' }, 502);
    }
    const image = falRes.ok ? model.output(data) : null;
    if (!image) return json({ error: 'The try-on service could not make this picture', status: falRes.status }, 502);

    if (key) await env.LIMITS.put(key, String(usedToday + 1), { expirationTtl: 172800 });
    return json({ image, left: key ? Math.max(0, limit - usedToday - 1) : null });
  },
};
