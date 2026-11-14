// Problem reports.
// When something goes wrong for a visitor (camera refused, the try-on server cannot be reached, the AI
// fails, a step that nobody gets past...), a short text note is sent to the Miraal server so the owner
// can see it on the private problems page and fix it. Never a picture, never the visitor's name.
// What is sent: what failed, where, the site version, phone and browser type, connection type, the
// time, and a random id made on this device (so ten notes from one phone are not counted as ten people).
// If the server cannot be reached right now, the note waits on the device and is sent on a later visit.

import { TRYON_API, TRYON_API_ALT } from './config.js?v=27';

export const SITE_VERSION = '27';
// on a developer machine the server address can be given as ?tryon=<url> for testing
const LOCAL_API = location.hostname === 'localhost' && new URLSearchParams(location.search).get('tryon');
const APIS = LOCAL_API ? LOCAL_API.split(',') : [TRYON_API, ...(TRYON_API_ALT || [])].filter(Boolean);
const QKEY = 'mirra.problems', VKEY = 'mirra.vid';
const MAX_WAITING = 20, MAX_A_DAY = 30;
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* blocked */ } },
};
const rand = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join('');
const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

export function visitorId() { return visitor(); }
function visitor() {
  let v = store.get(VKEY);
  if (!/^[0-9a-f]{12}$/.test(v || '')) { v = rand(6); store.set(VKEY, v); }
  return v;
}

// "Android 14 · Chrome 142 · 412x915" (short, no full browser fingerprint)
function device() {
  const ua = navigator.userAgent || '';
  const m = (re) => (re.exec(ua) || [])[1] || '';
  const os = m(/Android ([\d.]+)/) ? `Android ${m(/Android ([\d.]+)/)}`
    : /iPhone|iPad|iPod/.test(ua) ? `iPhone/iPad iOS ${m(/OS ([\d_]+)/).replace(/_/g, '.')}`
    : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Other';
  const inApp = /FBAN|FBAV|FB_IAB|Instagram|Line\/|TikTok|Snapchat|; wv\)/.test(ua) ? ' (inside another app)' : '';
  const br = m(/SamsungBrowser\/(\d+)/) ? `Samsung Internet ${m(/SamsungBrowser\/(\d+)/)}`
    : m(/EdgA?\/(\d+)/) ? `Edge ${m(/EdgA?\/(\d+)/)}`
    : m(/OPR\/(\d+)/) ? `Opera ${m(/OPR\/(\d+)/)}`
    : m(/(?:Firefox|FxiOS)\/(\d+)/) ? `Firefox ${m(/(?:Firefox|FxiOS)\/(\d+)/)}`
    : m(/(?:Chrome|CriOS)\/(\d+)/) ? `Chrome ${m(/(?:Chrome|CriOS)\/(\d+)/)}`
    : m(/Version\/(\d+)[\d.]* .*Safari/) ? `Safari ${m(/Version\/(\d+)[\d.]* .*Safari/)}` : 'Browser';
  return clip(`${os} · ${br}${inApp} · ${screen.width}x${screen.height}`, 80);
}
function network() {
  const c = navigator.connection;
  return clip([navigator.onLine === false ? 'offline' : '', c?.type, c?.effectiveType].filter(Boolean).join(' '), 20);
}

const waiting = () => { try { const q = JSON.parse(store.get(QKEY) || '[]'); return Array.isArray(q) ? q : []; } catch { return []; } };
const keep = (q) => store.set(QKEY, JSON.stringify(q.slice(-MAX_WAITING)));
const recent = new Map(); // the same problem twice within a minute is one problem
let sending = false;

/**
 * Note a problem. kind: short code such as "tryon.unreachable"; msg: one line; extra: small object.
 * Safe to call anywhere: it never throws and never blocks.
 */
export function reportProblem(kind, msg = '', extra = null) {
  try {
    const sig = `${kind}|${msg}`, now = Date.now();
    if (now - (recent.get(sig) || 0) < 60000) return;
    recent.set(sig, now);
    const dayKey = `mirra.problems.${new Date().toISOString().slice(0, 10)}`;
    const sent = parseInt(store.get(dayKey) || '0', 10) || 0;
    if (sent >= MAX_A_DAY) return;
    store.set(dayKey, String(sent + 1));
    const q = waiting();
    q.push({
      id: rand(4), kind: clip(kind, 40), msg: clip(msg, 300), ver: SITE_VERSION, t: now,
      place: clip(document.body.classList.contains('mirror-open') ? 'Try it on me' : document.body.classList.contains('scan-open') ? 'Body scan' : 'Page', 40),
      device: device(), net: network(), visitor: visitor(),
      extra: extra ? clip(JSON.stringify(extra), 200) : '',
    });
    keep(q);
    console.warn('Problem noted:', kind, msg);
    sendProblems();
  } catch { /* reporting must never break the page */ }
}

/** Send the waiting notes. Called by itself after a note, when the page opens and when the connection returns. */
export async function sendProblems() {
  if (sending || !APIS.length || !waiting().length) return;
  sending = true;
  let delivered = false;
  try {
    // the server takes 10 notes at a time; keep going while there are more (also picks up notes added meanwhile)
    for (let round = 0; round < 4; round++) {
      const q = waiting().slice(0, 10);
      if (!q.length) break;
      delivered = false;
      for (const api of APIS) {
        const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 8000);
        try {
          const r = await fetch(api, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reports: q }), signal: ctl.signal, keepalive: true });
          clearTimeout(timer);
          // received (or refused for good): stop keeping these. A server error keeps them for next time.
          if (r.status < 500) { const done = new Set(q.map((x) => x.id)); keep(waiting().filter((x) => !done.has(x.id))); delivered = true; break; }
        } catch { clearTimeout(timer); /* not reachable now: try the next address, or later */ }
      }
      if (!delivered) break;
    }
  } finally { sending = false; }
  if (delivered && waiting().length) setTimeout(sendProblems, 1500);
}

setTimeout(sendProblems, 4000);
addEventListener('online', () => sendProblems());
