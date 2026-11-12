// "Try it on me": photo try-on.
// 1. The camera guides the person to stand still and takes a clear photo by itself: front, then back.
// 2. The camera switches off. The person picks outfits and sees them on their own photo:
//    - a drawn preview right away (made on the device, nothing uploaded)
//    - "See it for real": the photo and the outfit picture go to the Miraal try-on server, which asks
//      the AI try-on service for a realistic picture (only when the site has that server connected,
//      and only after the person agreed to it on the start card).
// Photos live in memory only and are wiped on Close.

import { STYLES, COLORS, photoUrl, lookFor } from './catalog.js?v=18';
import { getLandmarker } from './pose.js?v=18';
import { TRYON_API, DAILY_LIMIT, TRYON_PARTNER } from './config.js?v=18';

const $ = (s) => document.querySelector(s);
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const mix = (p, q, t) => [lerp(p[0], q[0], t), lerp(p[1], q[1], t)];
const sub = (p, q) => [p[0] - q[0], p[1] - q[1]];
const add = (p, q, k = 1) => [p[0] + q[0] * k, p[1] + q[1] * k];
const len = (v) => Math.hypot(v[0], v[1]) || 1;
const norm = (v) => { const l = len(v); return [v[0] / l, v[1] / l]; };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const GOLD = '#d9b26a';
// leg widths as a share of shoulder width at hip / knee / ankle
const LEGS = { shalwar: [0.5, 0.44, 0.17], slim: [0.38, 0.25, 0.17], wide: [0.42, 0.44, 0.52] };
const HOLD = 22; // still frames before the photo is taken
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* blocked */ } } };
// on a developer machine the server address can be given as ?tryon=<url> for testing
const API = (location.hostname === 'localhost' && new URLSearchParams(location.search).get('tryon')) || TRYON_API;

export function initMirror({ onStage, toast }) {
  const stage = $('#mirrorStage'), video = $('#mrVideo');
  const img = $('#mrImg'), drawCv = $('#mrDraw'), dctx = drawCv.getContext('2d'), frame = $('#mrFrame');
  const statusEl = $('#mrStatus'), hintEl = $('#mrHint');
  const rail = $('#mrRail'), colorsEl = $('#mrColors'), nameEl = $('#mrName'), subEl = $('#mrSub');
  const ring = $('#mrRing'), pctEl = $('#mrPct'), titleEl = $('#mrTitle'), textEl = $('#mrText'), skipBtn = $('#mrSkip');
  const realBtn = $('#mrReal'), leftEl = $('#mrLeft'), busy = $('#mrBusy'), sideEl = $('#mrSide');

  let stream = null, landmarker = null, G = null, raf = 0, lastT = -1, frameNo = 0, wakeLock = null;
  let look = lookFor('shalwar');
  let step = 'front', hold = 0, prev = null, stepStart = 0, lum = 140, lastLm = null;
  let photos = { front: null, back: null };   // { canvas, lm, url }
  let side = 'front';
  const results = new Map();                    // `${side}|${style}` -> picture address
  let voiceOk = false, lastSpoken = 0, lastSaid = '';
  const art = document.createElement('canvas'); art.width = art.height = 512;
  const swatch = document.createElement('canvas'); swatch.width = swatch.height = 128;
  let artKey = '', swatchPattern = null;
  const lightCv = document.createElement('canvas'); lightCv.width = lightCv.height = 16;
  const lctx = lightCv.getContext('2d', { willReadFrequently: true });

  /* ---------- daily allowance (the server enforces it too) ---------- */
  const dayKey = () => `mirra.ai.${new Date().toISOString().slice(0, 10)}`;
  const used = () => parseInt(store.get(dayKey()) || '0', 10) || 0;
  const leftToday = () => Math.max(0, DAILY_LIMIT - used());

  /* ---------- pickers ---------- */
  rail.innerHTML = Object.entries(STYLES).map(([k, v]) => `<button type="button" data-style="${k}"><img src="${photoUrl(k, 124)}" alt="" loading="lazy">${v.label}</button>`).join('');
  colorsEl.innerHTML = Object.entries(COLORS).map(([k, v]) => `<button type="button" data-color="${k}" style="--c:${v.hex}" aria-label="${v.label}" title="${v.label}"></button>`).join('');
  rail.addEventListener('click', (e) => { const b = e.target.closest('[data-style]'); if (b) { setLook(lookFor(b.dataset.style, look.size)); show(); } });
  colorsEl.addEventListener('click', (e) => { const b = e.target.closest('[data-color]'); if (b) { setLook({ ...look, color: b.dataset.color }); show(); } });
  sideEl.addEventListener('click', (e) => { const b = e.target.closest('[data-side]'); if (b && photos[b.dataset.side]) { side = b.dataset.side; show(); } });

  function setLook(next) {
    look = { ...next };
    rail.querySelectorAll('[data-style]').forEach((b) => b.classList.toggle('active', b.dataset.style === look.style));
    colorsEl.querySelectorAll('[data-color]').forEach((b) => b.classList.toggle('active', b.dataset.color === look.color));
    rail.querySelector('.active')?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }

  /* ---------- open / close ---------- */
  function setMode(m) { stage.dataset.mode = m; }
  function open(startLook) {
    setLook(startLook ? { ...lookFor(startLook.style), ...startLook } : look);
    stage.classList.add('open'); document.body.classList.add('mirror-open');
    $('#mrPrivacy').innerHTML = API
      ? `<b>Your photo.</b> The preview is made on your device. If you tap <b>See it for real</b>, your photo is sent to our try-on partner (${TRYON_PARTNER}) to make the picture. Miraal does not keep it.`
      : '<b>Private.</b> Your photos stay on your device. Nothing is uploaded, and they are deleted when you close this screen.';
    if (photos.front) { setMode('looks'); show(); } else { setMode('start'); statusEl.textContent = 'Your phone will ask to use the camera. Tap Allow.'; }
    onStage && onStage(true);
  }
  function close() {
    stopCamera();
    wipe();
    stage.classList.remove('open'); document.body.classList.remove('mirror-open');
    try { speechSynthesis.cancel(); } catch { /* ignore */ }
    onStage && onStage(false);
  }
  function wipe() {
    for (const p of Object.values(photos)) if (p) { p.canvas.width = p.canvas.height = 0; if (p.url) URL.revokeObjectURL(p.url); }
    photos = { front: null, back: null }; results.clear(); side = 'front';
    img.removeAttribute('src'); dctx.setTransform(1, 0, 0, 1, 0, 0); dctx.clearRect(0, 0, drawCv.width, drawCv.height);
  }
  document.querySelectorAll('[data-open-mirror]').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); open(); }));
  $('#mrClose').addEventListener('click', close);
  $('#mrCancel').addEventListener('click', close);
  $('#mrGo').addEventListener('click', () => { unlockSpeech(); startCamera(); });
  $('#mrRetake').addEventListener('click', () => { wipe(); startCamera(); });
  $('#mrShoot').addEventListener('click', () => { if (stream && lastLm) capture(lastLm); else if (stream) toast('Step into the picture first'); });
  skipBtn.addEventListener('click', () => finishCapture());
  realBtn.addEventListener('click', makeReal);
  $('#mrSave').addEventListener('click', savePicture);
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && stage.classList.contains('open')) close(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && stream) { stopCamera(); setMode('start'); statusEl.textContent = 'The camera turned off because you left the page.'; } });
  addEventListener('pagehide', () => { if (stream) stopCamera(); });
  addEventListener('resize', () => { if (stage.classList.contains('open') && stage.dataset.mode === 'looks') show(); });

  /* ---------- voice (helps when the phone is 2 m away) ---------- */
  function unlockSpeech() { try { if ('speechSynthesis' in window) { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); voiceOk = true; } } catch { /* ignore */ } }
  function speak(text, force) {
    if (!voiceOk || !text) return;
    const now = performance.now();
    if (!force && (text === lastSaid ? now - lastSpoken < 7000 : now - lastSpoken < 3500)) return;
    lastSpoken = now; lastSaid = text;
    try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.lang = 'en-US'; speechSynthesis.speak(u); } catch { /* ignore */ }
  }

  /* ---------- camera + guided capture ---------- */
  async function startCamera() {
    setMode('start');
    if (!navigator.mediaDevices?.getUserMedia) { statusEl.textContent = 'The camera is not available here. Open this page in Chrome or Safari.'; return; }
    statusEl.textContent = 'Waiting for the camera…';
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    } catch (e) {
      stream = null;
      statusEl.textContent = e && e.name === 'NotAllowedError' ? 'Camera permission was declined. Allow the camera in your browser settings and try again.' : 'No camera found. Close other apps using the camera and try again.';
      return;
    }
    video.srcObject = stream;
    await video.play().catch(() => {});
    statusEl.textContent = 'Getting ready… a few seconds the first time.';
    try {
      [landmarker, G] = await Promise.all([getLandmarker({ masks: false }), import('./scene.js?v=18')]);
    } catch (e) {
      console.warn('Try-on could not load', e);
      statusEl.textContent = 'This could not load. Check your internet connection and try again.';
      stopCamera();
      return;
    }
    if (!stream) return;
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { wakeLock = null; }
    setMode('capture');
    enterStep('front');
    lastT = -1; frameNo = 0;
    loop();
  }
  function stopCamera() {
    cancelAnimationFrame(raf);
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null; lastLm = null;
    video.pause(); video.srcObject = null;
    lctx.clearRect(0, 0, 16, 16);
    wakeLock?.release?.().catch?.(() => {}); wakeLock = null;
    hintEl.textContent = ''; hintEl.classList.remove('show');
  }
  function enterStep(s) {
    step = s; hold = 0; prev = null; stepStart = performance.now();
    nameEl.textContent = s === 'front' ? 'Photo 1 of 2 · Front' : 'Photo 2 of 2 · Back';
    subEl.textContent = 'The photo is taken by itself when you hold still';
    titleEl.textContent = s === 'front' ? 'Face the camera' : 'Now turn around';
    textEl.textContent = s === 'front' ? 'Stand back so we see you from head to knees. Arms a little away from your body.' : 'Back to the camera. Stand straight and hold still.';
    skipBtn.hidden = s === 'front';
    setRing(0);
    speak(s === 'front' ? 'Face the camera, step back until I can see you from head to knees, and hold still.' : 'Great. Now turn around, so your back faces the camera, and hold still.', true);
  }
  function setRing(p) { ring.style.setProperty('--p', Math.round(clamp(p, 0, 1) * 100)); pctEl.textContent = p > 0 ? `${Math.round(clamp(p, 0, 1) * 100)}%` : ''; }
  function setHint(t) { hintEl.textContent = t; hintEl.classList.toggle('show', !!t); if (t) speak(t); }

  function loop() {
    if (!stream) return;
    raf = requestAnimationFrame(loop);
    if (video.readyState < 2 || video.currentTime === lastT) return;
    lastT = video.currentTime;
    let res;
    try { res = landmarker.detectForVideo(video, performance.now()); } catch (e) { console.warn(e); return; }
    const lm = res.landmarks?.[0];
    res.close?.();
    frameNo++;
    if (frameNo % 20 === 1) sampleLight();
    lastLm = lm || null;
    const c = check(lm);
    if (c.ok) hold++; else hold = Math.max(0, hold - 2);
    setRing(hold / HOLD);
    setHint(c.ok ? '' : c.hint);
    titleEl.textContent = c.ok ? 'Hold still…' : step === 'front' ? 'Face the camera' : 'Now turn around';
    if (hold >= HOLD) capture(lm);
  }
  function sampleLight() {
    try {
      lctx.drawImage(video, 0, 0, 16, 16);
      const d = lctx.getImageData(0, 0, 16, 16).data;
      let s = 0; for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      lum = s / (d.length / 4);
    } catch { /* ignore */ }
  }

  // is this frame good enough for a clear try-on photo?
  function check(lm) {
    if (!lm) { prev = null; return { ok: false, hint: 'Step into the picture' }; }
    const vis = (i) => lm[i].visibility > 0.5;
    const inside = (i) => lm[i].x > 0.02 && lm[i].x < 0.98 && lm[i].y > 0.01 && lm[i].y < 0.99;
    const vw = video.videoWidth, vh = video.videoHeight;
    const sy = (lm[11].y + lm[12].y) / 2, hy = (lm[23].y + lm[24].y) / 2, ky = (lm[25].y + lm[26].y) / 2;
    const headTop = lm[0].y - 1.2 * Math.max(0.02, sy - lm[0].y);
    if (!(vis(11) && vis(12) && vis(23) && vis(24))) return { ok: false, hint: 'Step back so we can see your whole body' };
    if (headTop < 0.005) return { ok: false, hint: 'Your head is cut off. Step back or tilt the phone up' };
    if (!(vis(25) && vis(26) && inside(25) && inside(26))) return { ok: false, hint: 'Step back until your knees are in the picture' };
    if (!(inside(11) && inside(12))) return { ok: false, hint: 'Move to the middle of the picture' };
    if (ky - headTop < 0.42) return { ok: false, hint: 'Come a little closer' };
    if (lum <= 45) return { ok: false, hint: 'Too dark. Switch on a light in front of you' };
    const swPx = Math.abs(lm[11].x - lm[12].x) * vw, torsoPx = Math.max(1, (hy - sy) * vh);
    const squareOn = swPx / torsoPx > 0.5;
    const facing = lm[11].x > lm[12].x ? 'front' : 'back';
    if (!squareOn || facing !== step) return { ok: false, hint: step === 'front' ? 'Turn to face the camera' : 'Turn around so your back faces the camera' };
    const cx = (lm[11].x + lm[12].x + lm[23].x + lm[24].x) / 4, cy = (sy + hy) / 2;
    const moved = prev ? Math.hypot(cx - prev.x, cy - prev.y) : 1;
    prev = { x: cx, y: cy };
    if (moved > 0.006) return { ok: false, hint: performance.now() - stepStart > 2500 ? 'Hold still' : '' };
    return { ok: true };
  }

  // keep a clean, portrait crop of the person (2:3) and their joints inside it
  function capture(lm) {
    const vw = video.videoWidth, vh = video.videoHeight;
    const xs = [];
    for (let i = 0; i < 33; i++) if (lm[i].visibility > 0.5) xs.push(lm[i].x * vw);
    if (xs.length < 4) return;
    const sy = (lm[11].y + lm[12].y) / 2 * vh, noseY = lm[0].y * vh;
    const top = Math.max(0, noseY - 1.5 * Math.max(10, sy - noseY));
    const ankles = [27, 28].filter((i) => lm[i].visibility > 0.5 && lm[i].y < 1).map((i) => lm[i].y * vh);
    const bottom = Math.min(vh, ankles.length ? Math.max(...ankles) + 0.06 * vh : vh);
    const bodyW = Math.max(...xs) - Math.min(...xs), cx = (Math.max(...xs) + Math.min(...xs)) / 2;
    let w = Math.max((bottom - top) * 2 / 3, bodyW * 1.5), h = w * 1.5;
    if (h > vh) { h = vh; w = h * 2 / 3; }
    if (w > vw) { w = vw; h = Math.min(vh, w * 1.5); }
    const x0 = clamp(cx - w / 2, 0, vw - w), y0 = clamp(top - (h - (bottom - top)) / 2, 0, vh - h);
    const scale = Math.min(1, 1296 / h);
    const cv = document.createElement('canvas'); cv.width = Math.round(w * scale); cv.height = Math.round(h * scale);
    cv.getContext('2d').drawImage(video, x0, y0, w, h, 0, 0, cv.width, cv.height);
    photos[step] = { canvas: cv, lm: lm.map((p) => ({ x: (p.x * vw - x0) / w, y: (p.y * vh - y0) / h })), url: null };
    const fl = $('#mrFlash'); fl.classList.remove('go'); void fl.offsetWidth; fl.classList.add('go');
    speak(step === 'front' ? 'Got it.' : 'Done.', true);
    if (step === 'front') enterStep('back'); else finishCapture();
  }
  function finishCapture() {
    if (!photos.front) return;
    stopCamera();
    side = 'front';
    const list = Object.values(photos).filter(Boolean);
    let pending = list.length;
    for (const p of list) p.canvas.toBlob((b) => { p.url = b ? URL.createObjectURL(b) : null; if (--pending === 0) { setMode('looks'); show(); } }, 'image/jpeg', 0.92);
    speak('Your photos are ready. Pick an outfit.', true);
  }

  /* ---------- looks: outfits on the photo ---------- */
  function show() {
    if (!photos[side]) side = 'front';
    const p = photos[side];
    if (!p) return;
    nameEl.textContent = STYLES[look.style].label;
    sideEl.querySelectorAll('[data-side]').forEach((b) => { b.classList.toggle('active', b.dataset.side === side); b.disabled = !photos[b.dataset.side]; });
    const real = results.get(`${side}|${look.style}`);
    img.src = real || p.url;
    // size the frame to the photo (2:3) inside the free space
    const availW = stage.clientWidth - 24, availH = stage.clientHeight - 64 - ($('.mr-bottom').offsetHeight || 300) - 8;
    const ar = p.canvas.width / p.canvas.height;
    const fh = Math.max(180, Math.min(availH, availW / ar)), fw = fh * ar;
    frame.style.width = `${fw}px`; frame.style.height = `${fh}px`;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    drawCv.width = Math.round(fw * dpr); drawCv.height = Math.round(fh * dpr);
    dctx.setTransform(1, 0, 0, 1, 0, 0); dctx.clearRect(0, 0, drawCv.width, drawCv.height);
    stage.classList.toggle('is-real', !!real);
    if (!real && G) { dctx.setTransform(dpr, 0, 0, dpr, 0, 0); paintOutfit(dctx, fw, fh, (i) => [p.lm[i].x * fw, p.lm[i].y * fh], side === 'back'); }
    const left = leftToday();
    subEl.textContent = real ? 'Realistic picture made by AI from your photo' : 'Drawn preview on your photo';
    realBtn.hidden = !API || !!real;
    realBtn.disabled = left <= 0;
    realBtn.textContent = left > 0 ? 'See it for real' : 'No real try-ons left today';
    leftEl.textContent = !API ? 'Realistic AI try-on is not switched on yet. This is a drawn preview.'
      : real ? `${left} of ${DAILY_LIMIT} real try-ons left today` : left > 0 ? `Uses 1 of your ${left} real try-ons left today` : 'Come back tomorrow for more. The preview still works.';
  }

  async function makeReal() {
    const p = photos[side];
    if (!API || !p || leftToday() <= 0 || !busy.hidden) return;
    const key = `${side}|${look.style}`, style = look.style;
    busy.hidden = false; realBtn.disabled = true;
    try {
      const r = await fetch(API, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ person: p.canvas.toDataURL('image/jpeg', 0.9), garment: photoUrl(style, 800), style, side }),
      });
      const data = await r.json().catch(() => ({}));
      if (r.status === 429) { store.set(dayKey(), String(DAILY_LIMIT)); toast('You have used today’s real try-ons'); }
      else if (!r.ok || !data.image) throw new Error(data.error || `Server said ${r.status}`);
      else { results.set(key, data.image); store.set(dayKey(), String(used() + 1)); }
    } catch (e) {
      console.warn('AI try-on failed', e);
      toast('Could not make the picture. Please try again.');
    }
    busy.hidden = true;
    if (stage.classList.contains('open') && stage.dataset.mode === 'looks') show();
  }

  async function savePicture() {
    const p = photos[side]; if (!p) return;
    const real = results.get(`${side}|${look.style}`);
    const name = `miraal-${look.style}-${side}.jpg`;
    const download = (blob) => { const u = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 4000); };
    if (real) {
      try { download(await (await fetch(real)).blob()); } catch { window.open(real, '_blank', 'noopener'); }
      return;
    }
    const out = document.createElement('canvas'); out.width = p.canvas.width; out.height = p.canvas.height;
    const o = out.getContext('2d');
    o.drawImage(p.canvas, 0, 0);
    if (G) paintOutfit(o, out.width, out.height, (i) => [p.lm[i].x * out.width, p.lm[i].y * out.height], side === 'back');
    out.toBlob((b) => (b ? download(b) : toast('Could not save the picture')), 'image/jpeg', 0.92);
  }

  /* ---------- drawn preview of an outfit over the joints ---------- */
  function ensureArt(ctx, hex) {
    const key = `${look.style}|${look.pattern}|${look.color}`;
    if (key !== artKey) {
      artKey = key;
      const p = STYLES[look.style];
      G.paintFabric(art.getContext('2d'), 512, 512, hex, look.pattern || 'plain', { circ: 2 * Math.PI * 0.3 * 0.87, len: G.topMax(p) - p.bottom });
      swatch.getContext('2d').drawImage(art, 150, 190, 128, 128, 0, 0, 128, 128); // a border-free piece for sleeves
    }
    swatchPattern = ctx.createPattern(swatch, 'repeat');
  }

  function paintOutfit(ctx, cw, ch, P, isBack) {
    const p = STYLES[look.style];
    const hex = COLORS[look.color].hex;
    ensureArt(ctx, hex);

    // body frame from the joints
    let L = P(11), R = P(12); if (L[0] > R[0]) [L, R] = [R, L];
    const S = mix(L, R, 0.5), Hp = mix(P(23), P(24), 0.5), K = mix(P(25), P(26), 0.5), A = mix(P(27), P(28), 0.5);
    const T = len(sub(Hp, S));
    const sw = Math.max(len(sub(R, L)), 0.55 * T);
    const ux = 1.55 * sw;            // pixels per catalogue unit across the body
    const u = norm(sub(R, L));
    let uh = norm([-(A[1] - Hp[1]), A[0] - Hp[0]]); if (dot(uh, u) < 0) uh = [-uh[0], -uh[1]];
    const anchors = [[0.87, S], [0.15, Hp], [-0.48, K], [-1.08, A]];
    const axis = (y) => {
      if (y >= 0.87) return add(S, sub(S, Hp), (y - 0.87) / 0.72);
      for (let i = 1; i < anchors.length; i++) if (y >= anchors[i][0]) { const [y0, a] = anchors[i - 1], [y1, b] = anchors[i]; return mix(a, b, (y0 - y) / (y0 - y1)); }
      return add(A, sub(A, K), (-1.08 - y) / 0.6);
    };
    const across = (y) => norm(mix(u, uh, clamp((0.15 - y) / 0.7, 0, 1) * 0.8));
    const half = (y) => G.garmentBaseR(p, 0.013, y) * (1 + 0.42 * G.bump(y, 0.8, 0.985)) * ux * (y < 0.8 ? 0.93 : 1);
    const edge = (y, sgn) => add(axis(y), across(y), sgn * half(y));
    const top = G.topMax(p), bot = p.bottom;
    const dark = clamp((150 - lum) / 300, 0, 0.3);  // dim rooms get a darker garment

    const softShadow = () => { ctx.shadowColor = 'rgba(0,0,0,.32)'; ctx.shadowBlur = 16; ctx.shadowOffsetY = 5; };
    const noShadow = () => { ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0; };
    const tube = (pts, widths) => {
      const left = [], right = [];
      for (let i = 0; i < pts.length; i++) {
        const d = norm(sub(pts[Math.min(i + 1, pts.length - 1)], pts[Math.max(i - 1, 0)]));
        const n = [-d[1], d[0]];
        left.push(add(pts[i], n, widths[i] / 2)); right.push(add(pts[i], n, -widths[i] / 2));
      }
      ctx.beginPath(); ctx.moveTo(...left[0]);
      for (let i = 1; i < left.length; i++) ctx.lineTo(...left[i]);
      for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(...right[i]);
      ctx.closePath();
      return { endA: left[left.length - 1], endB: right[right.length - 1] };
    };
    const shade = (hexCol, k) => G.mixHex(hexCol, '#000000', k);

    /* trousers (behind the kameez) */
    if (p.trousers) {
      const W = LEGS[p.trousers.kind];
      const legHex = shade(hex, p.bottom > -0.2 ? 0.0 : 0.08);
      for (const [h, k, a] of [[23, 25, 27], [24, 26, 28]]) {
        const hip = mix(P(h), Hp, 0.15), knee = P(k), ank = mix(knee, P(a), 0.97);
        const pts = [hip, mix(hip, knee, 0.5), knee, mix(knee, ank, 0.55), mix(knee, ank, 0.9), ank];
        const w = p.trousers.kind === 'shalwar'
          ? [W[0], W[0] * 1.02, W[1], W[1] * 0.92, W[2] * 1.25, W[2]]
          : [W[0], lerp(W[0], W[1], 0.5), W[1], lerp(W[1], W[2], 0.55), lerp(W[1], W[2], 0.9), W[2]];
        softShadow(); ctx.fillStyle = legHex; tube(pts, w.map((x) => x * sw)); ctx.fill(); noShadow();
        ctx.save(); ctx.clip();
        const g = ctx.createLinearGradient(...add(knee, u, -W[1] * sw / 2), ...add(knee, u, W[1] * sw / 2));
        g.addColorStop(0, 'rgba(0,0,0,.28)'); g.addColorStop(0.5, 'rgba(255,255,255,.06)'); g.addColorStop(1, 'rgba(0,0,0,.28)');
        ctx.fillStyle = g; ctx.fillRect(0, 0, cw, ch);
        ctx.restore();
      }
    }

    /* dupatta tails hang from the shoulders */
    const dupHex = p.dupatta ? G.mixHex(hex, '#ffffff', G.lightness(hex) > 0.5 ? 0.12 : 0.25) : null;
    const dupW = 0.2 * sw;
    const ribbon = (pathFn) => {
      ctx.lineCap = 'butt'; ctx.lineJoin = 'round';
      ctx.globalAlpha = 0.8; ctx.strokeStyle = GOLD; ctx.lineWidth = dupW; pathFn(); ctx.stroke();
      ctx.strokeStyle = dupHex; ctx.lineWidth = Math.max(2, dupW - 6); pathFn(); ctx.stroke();
      ctx.globalAlpha = 1;
    };
    const tails = () => {
      for (const sgn of [-1, 1]) {
        const a = add(axis(0.9), u, sgn * half(0.88) * 0.86), b = add(axis(0.05), across(0.05), sgn * (half(0.05) + dupW * 0.25));
        ribbon(() => { ctx.beginPath(); ctx.moveTo(...a); ctx.quadraticCurveTo(...add(mix(a, b, 0.5), u, sgn * dupW * 0.5), ...b); });
      }
    };
    if (p.dupatta && !isBack) tails();

    /* main garment: bodice + skirt (lehenga = two pieces with a bare midriff) */
    const ranges = p.midriff ? [[top, p.midriff[1]], [p.midriff[0], bot]] : [[top, bot]];
    const bodyPath = () => {
      ctx.beginPath();
      ranges.forEach(([y0, y1], ri) => {
        const N = 26, Lp = [], Rp = [];
        for (let i = 0; i <= N; i++) { const y = lerp(y0, y1, i / N); Lp.push(edge(y, -1)); Rp.push(edge(y, 1)); }
        ctx.moveTo(...Lp[0]);
        for (let i = 1; i <= N; i++) ctx.lineTo(...Lp[i]);
        const down = norm(sub(axis(y1), axis(y1 + 0.1)));
        const bow = ri === ranges.length - 1 ? 0.035 * T : 0.01 * T;
        ctx.quadraticCurveTo(...add(axis(y1), down, bow * 2), ...Rp[N]);
        for (let i = N - 1; i >= 0; i--) ctx.lineTo(...Rp[i]);
        // neckline dips at the front; the back is cut higher
        const dip = ri === 0 ? (p.neck ? p.neck.dip * (isBack ? 0.3 : 1) : 0.012) : 0;
        ctx.quadraticCurveTo(...axis(y0 - dip * 2), ...Lp[0]);
        ctx.closePath();
      });
    };
    softShadow(); ctx.fillStyle = hex; bodyPath(); ctx.fill(); noShadow();

    ctx.save();
    bodyPath(); ctx.clip();
    const Ct = axis(top), Cb = axis(bot);
    const d = sub(Cb, Ct), L2 = len(d) + 0.08 * T;
    let maxHW = 0; for (let i = 0; i <= 12; i++) maxHW = Math.max(maxHW, half(lerp(top, bot, i / 12)));
    maxHW *= 1.04;
    ctx.translate(...Ct); ctx.rotate(Math.atan2(d[1], d[0]) - Math.PI / 2);
    // the cloth artwork wraps the whole body: front half for the front photo, back half for the back
    if (isBack) ctx.drawImage(art, 128, 0, 256, 512, -maxHW, -0.02 * T, 2 * maxHW, L2);
    else { ctx.drawImage(art, 384, 0, 128, 512, -maxHW, -0.02 * T, maxHW, L2); ctx.drawImage(art, 0, 0, 128, 512, 0, -0.02 * T, maxHW, L2); }
    const g = ctx.createLinearGradient(-maxHW, 0, maxHW, 0);
    g.addColorStop(0, 'rgba(0,0,0,.36)'); g.addColorStop(0.2, 'rgba(0,0,0,.1)'); g.addColorStop(0.5, 'rgba(255,255,255,.08)');
    g.addColorStop(0.8, 'rgba(0,0,0,.1)'); g.addColorStop(1, 'rgba(0,0,0,.36)');
    ctx.fillStyle = g; ctx.fillRect(-maxHW, -0.05 * T, 2 * maxHW, L2 + 0.1 * T);
    const wy = p.waist ?? 0.515;
    if (bot < wy - 0.25) {
      const yl = (y) => dot(sub(axis(y), Ct), norm(d));
      const y0 = yl(wy), y1 = L2, hw0 = half(wy), hw1 = half(bot);
      const n = clamp(Math.round((p.pleats || 8) * 0.5), 5, 16);
      // folds fade in below the waist so they do not read as a seam
      const fade = (rgb, a) => { const fg = ctx.createLinearGradient(0, y0, 0, y1); fg.addColorStop(0, `rgba(${rgb},0)`); fg.addColorStop(0.35, `rgba(${rgb},${a})`); fg.addColorStop(1, `rgba(${rgb},${a})`); return fg; };
      const foldDark = fade('0,0,0', 0.14), foldLight = fade('255,255,255', 0.08);
      for (let i = 0; i < n; i++) {
        const f = ((i + 0.5) / n) * 2 - 1;
        ctx.beginPath(); ctx.moveTo(f * hw0 * 0.85, y0); ctx.quadraticCurveTo(f * lerp(hw0, hw1, 0.5), lerp(y0, y1, 0.55), f * hw1, y1);
        ctx.strokeStyle = foldDark; ctx.lineWidth = Math.max(2, sw * 0.014); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(f * hw0 * 0.85 + 3, y0); ctx.quadraticCurveTo(f * lerp(hw0, hw1, 0.5) + 4, lerp(y0, y1, 0.55), f * hw1 + 5, y1);
        ctx.strokeStyle = foldLight; ctx.lineWidth = Math.max(1.5, sw * 0.01); ctx.stroke();
      }
    }
    if (dark > 0) { ctx.fillStyle = `rgba(0,0,0,${dark})`; ctx.fillRect(-maxHW, -0.05 * T, 2 * maxHW, L2 + 0.1 * T); }
    ctx.restore();

    /* straps */
    if (p.straps) {
      ctx.strokeStyle = shade(hex, 0.1); ctx.lineWidth = Math.max(3, sw * (p.trousers ? 0.045 : 0.022)); ctx.lineCap = 'round';
      for (const sgn of [-1, 1]) {
        const a = add(axis(top), u, sgn * half(top) * 0.52), b = add(axis(0.93), u, sgn * half(0.9) * 0.6);
        ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke();
      }
    }

    /* sleeves (over the bodice) */
    if (p.sleeves) {
      const s = p.sleeves, f = clamp(s.len / 0.62, 0.15, 1);
      for (const [sh, el, wr] of [[11, 13, 15], [12, 14, 16]]) {
        const a = mix(P(sh), S, 0.06), e = P(el), w = P(wr);
        const pts = f <= 0.5 ? [a, mix(a, e, f / 0.5)] : [a, e, mix(e, w, (f - 0.5) / 0.5)];
        const w0 = s.r0 * 2 * ux * 1.2, w1 = s.r1 * 2 * ux * 1.2;
        const widths = pts.length === 2 ? [w0, lerp(w0, w1, 0.6)] : [w0, lerp(w0, w1, 0.5), w1];
        softShadow(); ctx.fillStyle = hex; const end = tube(pts, widths); ctx.fill(); noShadow();
        ctx.save(); ctx.clip();
        if (look.pattern && look.pattern !== 'plain' && swatchPattern) { ctx.fillStyle = swatchPattern; ctx.fillRect(0, 0, cw, ch); }
        ctx.strokeStyle = 'rgba(0,0,0,.22)'; ctx.lineWidth = Math.max(4, w0 * 0.28); tube(pts, widths); ctx.stroke();
        if (dark > 0) { ctx.fillStyle = `rgba(0,0,0,${dark})`; ctx.fillRect(0, 0, cw, ch); }
        ctx.restore();
        if (look.pattern && look.pattern !== 'plain') { ctx.strokeStyle = GOLD; ctx.lineWidth = Math.max(3, sw * 0.02); ctx.lineCap = 'butt'; ctx.beginPath(); ctx.moveTo(...end.endA); ctx.lineTo(...end.endB); ctx.stroke(); }
      }
    }

    /* dupatta: across the chest at the front, hanging down the back */
    if (p.dupatta) {
      if (isBack) tails();
      else {
        const a = add(axis(0.9), u, -half(0.88) * 0.86), b = add(axis(0.9), u, half(0.88) * 0.86), c = axis(0.36);
        ribbon(() => { ctx.beginPath(); ctx.moveTo(...a); ctx.bezierCurveTo(...mix(a, c, 0.75), ...mix(b, c, 0.75), ...b); });
      }
    }
  }

  setLook(look);
  return { open };
}
