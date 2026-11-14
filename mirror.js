// "Try it on me": photo try-on.
// 1. The camera guides the person to stand still and takes a clear photo by itself: front, then back.
// 2. The camera switches off. The person picks outfits and sees them on their own photo:
//    - a drawn preview right away (made on the device, nothing uploaded)
//    - "See it for real": the photo and the outfit picture go to the Miraal try-on server, which asks
//      the AI try-on service for a realistic picture (only when the site has that server connected,
//      and only after the person agreed to it on the start card).
// Photos live in memory only and are wiped on Close.

import { ALL, COLORS, STITCH, stitchedStyle, photoUrl, lookFor } from './catalog.js?v=26';
import { getLandmarker } from './pose.js?v=26';
import { TRYON_API, TRYON_API_ALT, DAILY_LIMIT, TRYON_PARTNER } from './config.js?v=26';
import { reportProblem, sendProblems } from './report.js?v=26';

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
const LEGS = { shalwar: [0.5, 0.44, 0.17], khuli: [0.5, 0.48, 0.42], kali: [0.62, 0.58, 0.2], slim: [0.38, 0.25, 0.17], pajama: [0.38, 0.25, 0.17],
  trouser: [0.4, 0.31, 0.27], jeans: [0.4, 0.3, 0.26], wide: [0.42, 0.44, 0.52] };
const GATHERED = ['shalwar', 'kali']; // full legs gathered in at the ankle
const COUNT_MS = 3000; // hold still this long (3, 2, 1) and the photo is taken
const CAM_KEY = 'mirra.cam'; // 'user' (front camera) or 'environment' (back camera, someone else holds the phone)
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* blocked */ } } };
// on a developer machine the server address can be given as ?tryon=<url> for testing
const LOCAL_API = location.hostname === 'localhost' && new URLSearchParams(location.search).get('tryon');
const APIS = LOCAL_API ? LOCAL_API.split(',') : [TRYON_API, ...(TRYON_API_ALT || [])].filter(Boolean);
let API = APIS[0] || ''; // the address in use; changes if another one turns out to be reachable
// does this address answer at all from this phone's internet connection?
async function reachable(url, ms = 7000) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
  try { await fetch(url, { method: 'GET', mode: 'no-cors', cache: 'no-store', signal: ctl.signal }); return true; }
  catch { return false; }
  finally { clearTimeout(t); }
}
const loads = (url, ms = 20000) => new Promise((res) => {
  const im = new Image(), t = setTimeout(() => { im.src = ''; res(false); }, ms);
  im.onload = () => { clearTimeout(t); res(true); };
  im.onerror = () => { clearTimeout(t); res(false); };
  im.src = url;
});

export function initMirror({ onStage, toast }) {
  const stage = $('#mirrorStage'), video = $('#mrVideo');
  const img = $('#mrImg'), drawCv = $('#mrDraw'), dctx = drawCv.getContext('2d'), frame = $('#mrFrame');
  const statusEl = $('#mrStatus'), hintEl = $('#mrHint');
  const rail = $('#mrRail'), colorsEl = $('#mrColors'), nameEl = $('#mrName'), subEl = $('#mrSub');
  const ring = $('#mrRing'), pctEl = $('#mrPct'), titleEl = $('#mrTitle'), textEl = $('#mrText'), skipBtn = $('#mrSkip');
  const realBtn = $('#mrReal'), leftEl = $('#mrLeft'), busy = $('#mrBusy'), sideEl = $('#mrSide');
  const countEl = $('#mrCount'), flipBtn = $('#mrFlip'), camBtns = stage.querySelectorAll('[data-cam]');

  let stream = null, landmarker = null, G = null, raf = 0, lastT = -1, frameNo = 0, wakeLock = null;
  let look = lookFor('shalwar');
  let step = 'front', prev = null, stepStart = 0, lum = 140, lastLm = null;
  let holdStart = 0, badSince = 0, forced = false, lastFrameT = 0, shownCount = 0;
  let camWant = 'user', rear = false, flipping = false, camRun = 0, session = 0, audio = null, badFrames = 0;
  let notice = ''; // why the last real try-on did not work; stays on screen until the next try
  let sketch = false;   // the quick drawn sketch is off unless the person asks for it
  let autoReal = false; // an outfit picked in the shop is tried on for real as soon as the photos are taken
  let clock = 0;
  const secsEl = $('#mrSecs'), sketchBtn = $('#mrSketch');
  let hintCount = {}, stuckSent = false; // which hint a person keeps seeing when they cannot get the photo taken
  let photos = { front: null, back: null };   // { canvas, lm, url }
  let side = 'front';
  let tab = 'women';                             // 'women' | 'men' | 'fabric'
  let cloth = null;                              // the customer's fabric: { tile, data, avg, id }
  let stitch = { wearer: 'men', neck: 'gol', bottom: 'shalwar' };
  const stitched = new Map();                    // fabric + stitching -> stitched suit picture made by the AI
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
  const tabsEl = $('#mrTabs'), fabricEl = $('#mrFabric');
  function renderRail() {
    rail.innerHTML = Object.entries(ALL).filter(([, v]) => (v.gender === 'men') === (tab === 'men'))
      .map(([k, v]) => `<button type="button" data-style="${k}"><img src="${photoUrl(k, 124)}" alt="" loading="lazy">${v.label}</button>`).join('');
  }
  function setTab(t) {
    tab = t; stage.dataset.tab = t;
    tabsEl.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    if (tab !== 'fabric') {
      renderRail();
      const isMen = ALL[look.style].gender === 'men';
      setLook(isMen === (tab === 'men') ? look : lookFor(tab === 'men' ? 'm_shalwar' : 'shalwar', look.size));
    }
    if (stage.classList.contains('open') && stage.dataset.mode === 'looks') show();
  }
  tabsEl.addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) setTab(b.dataset.tab); });

  /* ---------- unstitched fabric: bring a picture, choose the stitching ---------- */
  const syncStitch = () => fabricEl.querySelectorAll('[data-opt]').forEach((row) => row.querySelectorAll('[data-v]').forEach((b) => b.classList.toggle('active', b.dataset.v === stitch[row.dataset.opt])));
  fabricEl.querySelectorAll('[data-opt]').forEach((row) => {
    const k = row.dataset.opt;
    row.innerHTML = Object.entries(STITCH[k]).map(([v, l]) => `<button type="button" data-v="${v}">${l}</button>`).join('');
    row.addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (!b) return; stitch = { ...stitch, [k]: b.dataset.v }; syncStitch(); show(); });
  });
  syncStitch();
  $('#mrFabUpload').addEventListener('click', () => $('#mrFabFile').click());
  $('#mrFabFile').addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; if (f) loadCloth(URL.createObjectURL(f), true); e.target.value = ''; });
  $('#mrFabUse').addEventListener('click', () => { const u = $('#mrFabUrl').value.trim(); if (/^https:\/\//i.test(u)) loadCloth(u, false); else toast('Paste a picture link that starts with https://'); });
  function loadCloth(src, isBlob) {
    const load = (url, cors) => new Promise((res, rej) => { const im = new Image(); if (cors) im.crossOrigin = 'anonymous'; im.onload = () => res(im); im.onerror = rej; im.src = url; });
    (async () => {
      let im;
      // a web link is tried directly first; shops that forbid that are fetched through the Miraal server
      try { im = await load(src, !isBlob); }
      catch (e) { if (isBlob || !API) throw e; im = await load(`${API}?img=${encodeURIComponent(src)}`, true); }
      const sc = Math.min(1, 768 / Math.max(im.naturalWidth, im.naturalHeight));
      const small = document.createElement('canvas'); small.width = Math.max(8, Math.round(im.naturalWidth * sc)); small.height = Math.max(8, Math.round(im.naturalHeight * sc));
      small.getContext('2d').drawImage(im, 0, 0, small.width, small.height);
      const data = small.toDataURL('image/jpeg', 0.88);
      // a seamless tile from the middle of the picture for the drawn preview
      const tile = document.createElement('canvas'); tile.width = tile.height = 512;
      const t = tile.getContext('2d'), sq = Math.min(small.width, small.height) * 0.6, sx = (small.width - sq) / 2, sy = (small.height - sq) / 2;
      for (const [fx, fy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) { t.save(); t.translate(fx ? 512 : 0, fy ? 512 : 0); t.scale(fx ? -1 : 1, fy ? -1 : 1); t.drawImage(small, sx, sy, sq, sq, 0, 0, 256, 256); t.restore(); }
      const one = document.createElement('canvas'); one.width = one.height = 1;
      const og = one.getContext('2d'); og.drawImage(tile, 0, 0, 1, 1);
      const [r, g, b] = og.getImageData(0, 0, 1, 1).data;
      cloth = { tile, data, avg: `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`, id: String(Date.now()) };
      $('#mrFabThumb').src = data; $('#mrFabThumb').hidden = false;
      if (isBlob) URL.revokeObjectURL(src);
      if (stage.dataset.mode === 'looks') show();
    })().catch(() => { if (isBlob) URL.revokeObjectURL(src); let host = ''; try { host = isBlob ? 'uploaded photo' : `link on ${new URL(src).hostname}`; } catch { host = 'link'; } reportProblem('fabric.open_failed', host); toast('That picture could not be opened. Save it to your phone and upload it instead.'); });
  }
  const custom = () => tab === 'fabric';
  const styleNow = () => (custom() ? stitchedStyle(stitch) : ALL[look.style]);
  const resultKey = () => (custom() ? `${side}|fabric|${cloth ? cloth.id : ''}|${stitch.wearer}|${stitch.neck}|${stitch.bottom}` : `${side}|${look.style}`);
  colorsEl.innerHTML = Object.entries(COLORS).map(([k, v]) => `<button type="button" data-color="${k}" style="--c:${v.hex}" aria-label="${v.label}" title="${v.label}"></button>`).join('');
  rail.addEventListener('click', (e) => { const b = e.target.closest('[data-style]'); if (b) { setLook(lookFor(b.dataset.style, look.size)); show(); } });
  colorsEl.addEventListener('click', (e) => { const b = e.target.closest('[data-color]'); if (b) { setLook({ ...look, color: b.dataset.color }); show(); } });
  sideEl.addEventListener('click', (e) => { const b = e.target.closest('[data-side]'); if (b && photos[b.dataset.side]) { side = b.dataset.side; show(); } });

  function setLook(next) {
    if (next.style !== look.style) notice = '';
    look = { ...next };
    rail.querySelectorAll('[data-style]').forEach((b) => b.classList.toggle('active', b.dataset.style === look.style));
    colorsEl.querySelectorAll('[data-color]').forEach((b) => b.classList.toggle('active', b.dataset.color === look.color));
    rail.querySelector('.active')?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }

  /* ---------- open / close ---------- */
  function setMode(m) { stage.dataset.mode = m; }
  function open(startLook, startTab) {
    if (startLook && !ALL[startLook.style]) startLook = null;
    autoReal = !!startLook; sketch = false;
    if (startLook) look = { ...lookFor(startLook.style), ...startLook };
    setTab(startTab || (ALL[look.style].gender === 'men' ? 'men' : 'women'));
    camWant = store.get(CAM_KEY) === 'environment' ? 'environment' : 'user'; syncCam();
    stage.classList.add('open'); document.body.classList.add('mirror-open');
    $('#mrPrivacy').innerHTML = API
      ? `Your photo is sent to our try-on partner (${TRYON_PARTNER}) to make your picture. Miraal does not keep it. If something fails, a short note without any picture is sent so we can fix it.`
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
    photos = { front: null, back: null }; results.clear(); stitched.clear(); side = 'front';
    session++; busy.hidden = true; stopClock(); // a picture still being made belongs to the old photos
    notice = '';
    img.removeAttribute('src'); dctx.setTransform(1, 0, 0, 1, 0, 0); dctx.clearRect(0, 0, drawCv.width, drawCv.height);
  }
  document.querySelectorAll('[data-open-mirror]').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); open(null, b.dataset.openMirror || null); }));
  $('#mrClose').addEventListener('click', close);
  $('#mrCancel').addEventListener('click', close);
  $('#mrGo').addEventListener('click', () => { unlockSpeech(); startCamera(); });
  $('#mrRetake').addEventListener('click', () => { wipe(); startCamera(); });
  // the button starts the same 3-second countdown, so the tap does not shake the picture
  $('#mrShoot').addEventListener('click', () => { if (!stream) return; if (!lastLm) { toast('Step into the picture first'); return; } forced = true; holdStart = performance.now(); badSince = 0; });
  flipBtn.addEventListener('click', flip);
  camBtns.forEach((b) => b.addEventListener('click', () => { camWant = b.dataset.cam; store.set(CAM_KEY, camWant); syncCam(); }));
  function syncCam() {
    camBtns.forEach((b) => b.classList.toggle('on', b.dataset.cam === camWant));
    $('#mrTipPhone').textContent = camWant === 'environment' ? 'Someone holds the phone and stands back' : 'Stand your phone up and step back';
  }
  skipBtn.addEventListener('click', () => finishCapture());
  realBtn.addEventListener('click', makeReal);
  $('#mrSave').addEventListener('click', savePicture);
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && stage.classList.contains('open')) close(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && stream) { stopCamera(); setMode('start'); statusEl.textContent = 'The camera turned off because you left the page.'; } });
  addEventListener('pagehide', () => { if (stream) stopCamera(); });
  addEventListener('resize', () => { if (stage.classList.contains('open') && stage.dataset.mode === 'looks') show(); });

  /* ---------- voice (helps when the phone is 2 m away) ---------- */
  function unlockSpeech() {
    try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); if (audio.state === 'suspended') audio.resume(); } catch { audio = null; }
    try { if ('speechSynthesis' in window) { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); voiceOk = true; } } catch { /* ignore */ }
  }
  // a short beep for each second of the countdown (the person may have their back to the screen)
  function beep(last) {
    if (!audio) return;
    try {
      const t = audio.currentTime, o = audio.createOscillator(), g = audio.createGain();
      o.frequency.value = last ? 1320 : 880;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.22, t + 0.015); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.17);
      o.connect(g); g.connect(audio.destination); o.start(t); o.stop(t + 0.2);
    } catch { /* ignore */ }
  }
  function speak(text, force) {
    if (!voiceOk || !text) return;
    const now = performance.now();
    if (!force && (text === lastSaid ? now - lastSpoken < 7000 : now - lastSpoken < 3500)) return;
    lastSpoken = now; lastSaid = text;
    // cancelling when nothing is playing makes some phones drop the next sentence
    try { if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.lang = 'en-US'; speechSynthesis.speak(u); } catch { /* ignore */ }
  }

  /* ---------- camera + guided capture ---------- */
  async function startCamera() {
    if (stream) stopCamera(); // a second tap must not leave the first camera running
    setMode('start');
    if (!navigator.mediaDevices?.getUserMedia) { reportProblem('tryon.no_camera_api', 'This browser gives the page no camera'); statusEl.textContent = 'The camera is not available here. Open this page in Chrome or Safari.'; return; }
    statusEl.textContent = 'Waiting for the camera…';
    const run = ++camRun;
    let s;
    try {
      s = await openStream();
    } catch (e) {
      if (run !== camRun) return;
      stream = null;
      reportProblem(e && e.name === 'NotAllowedError' ? 'tryon.camera_denied' : 'tryon.camera_failed', `${e && e.name}: ${e && e.message}`);
      statusEl.textContent = e && e.name === 'NotAllowedError' ? 'Camera permission was declined. Allow the camera in your browser settings and try again.' : 'No camera found. Close other apps using the camera and try again.';
      return;
    }
    // closed while the phone was still asking for permission: switch the camera straight off again
    if (run !== camRun) { s.getTracks().forEach((t) => t.stop()); return; }
    stream = s;
    video.srcObject = stream;
    await video.play().catch(() => {});
    navigator.mediaDevices.enumerateDevices?.().then((d) => { flipBtn.hidden = d.filter((x) => x.kind === 'videoinput').length < 2; }).catch(() => {});
    statusEl.textContent = 'Getting ready… a few seconds the first time.';
    try {
      [landmarker, G] = await Promise.all([getLandmarker({ masks: false }), import('./scene.js?v=26')]);
    } catch (e) {
      console.warn('Try-on could not load', e);
      reportProblem('tryon.tracker_load', String(e && e.message || e));
      if (run !== camRun) return;
      stopCamera();
      statusEl.textContent = 'This could not load. Check your internet connection and try again.';
      return;
    }
    if (run !== camRun || !stream) return;
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { wakeLock = null; }
    setMode('capture');
    enterStep('front');
    lastT = -1; frameNo = 0;
    loop();
  }
  async function openStream() {
    const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: camWant, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    const track = s.getVideoTracks()[0], set = track?.getSettings?.() || {};
    // the selfie camera is shown like a mirror; the back camera is shown as it is
    rear = set.facingMode ? set.facingMode === 'environment' : /back|rear|environment/i.test(track?.label || '');
    stage.classList.toggle('rear', rear);
    return s;
  }
  async function flip() {
    if (!stream || flipping) return;
    flipping = true;
    const run = camRun;
    cancelAnimationFrame(raf);
    stream.getTracks().forEach((t) => t.stop()); // a phone cannot run both cameras at once
    const before = camWant;
    camWant = before === 'environment' ? 'user' : 'environment';
    let s = null;
    try { s = await openStream(); }
    catch { camWant = before; try { s = await openStream(); } catch { s = null; } }
    flipping = false;
    if (run !== camRun) { s?.getTracks().forEach((t) => t.stop()); return; }
    if (!s) { stopCamera(); setMode('start'); statusEl.textContent = 'The camera could not be switched. Tap Agree & start camera to try again.'; return; }
    if (camWant === before) toast('The other camera could not be opened');
    store.set(CAM_KEY, camWant); syncCam();
    stream = s; video.srcObject = s;
    await video.play().catch(() => {});
    if (run !== camRun) return;
    resetHold(); prev = null; lastT = -1; stepStart = performance.now();
    describeStep();
    loop();
  }
  function stopCamera() {
    camRun++;
    cancelAnimationFrame(raf);
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null; lastLm = null; badFrames = 0;
    video.pause(); video.srcObject = null;
    lctx.clearRect(0, 0, 16, 16);
    wakeLock?.release?.().catch?.(() => {}); wakeLock = null;
    hintEl.textContent = ''; hintEl.classList.remove('show');
    resetHold();
  }
  function resetHold() { holdStart = 0; badSince = 0; forced = false; shownCount = 0; countEl.textContent = ''; pctEl.textContent = ''; setRing(0); }
  function describeStep() {
    nameEl.textContent = step === 'front' ? 'Photo 1 of 2 · Front' : 'Photo 2 of 2 · Back';
    subEl.textContent = 'Hold still for 3 seconds';
    titleEl.textContent = step === 'front' ? 'Face the camera' : 'Now turn around';
    textEl.textContent = rear
      ? (step === 'front' ? 'Hold the phone steady. Head to knees in the picture.' : 'Their back to the camera. Hold steady.')
      : (step === 'front' ? 'Head to knees in the picture.' : 'Back to the camera.');
  }
  function enterStep(s) {
    hintCount = {}; stuckSent = false;
    step = s; prev = null; stepStart = performance.now();
    resetHold();
    describeStep();
    skipBtn.hidden = s === 'front';
    speak(s === 'front' ? 'Face the camera, step back until I can see you from head to knees, and hold still for three seconds.' : 'Great. Now turn around, so your back faces the camera, and hold still.', true);
  }
  function setRing(p) { ring.style.setProperty('--p', Math.round(clamp(p, 0, 1) * 100)); }
  function setHint(t) { hintEl.textContent = t; hintEl.classList.toggle('show', !!t); if (t) speak(t); }

  function loop() {
    if (!stream) return;
    raf = requestAnimationFrame(loop);
    if (video.readyState < 2 || video.currentTime === lastT) return;
    lastT = video.currentTime;
    let res;
    try { res = landmarker.detectForVideo(video, performance.now()); }
    catch (e) {
      console.warn(e);
      // the tracker failing on every picture would otherwise leave the person waiting forever
      if (++badFrames > 40) { reportProblem('tryon.tracker_crash', String(e && e.message || e)); stopCamera(); setMode('start'); statusEl.textContent = 'The camera guide stopped working. Tap Agree & start camera to try again, or open this page in Chrome or Safari.'; }
      return;
    }
    badFrames = 0;
    const lm = res.landmarks?.[0];
    res.close?.();
    frameNo++;
    if (frameNo % 20 === 1) sampleLight();
    lastLm = lm || null;
    const now = performance.now();
    const dt = lastFrameT ? Math.min(0.5, (now - lastFrameT) / 1000) : 0.033;
    lastFrameT = now;
    const c = check(lm, dt);
    // the countdown runs while the picture is good; a brief wobble does not restart it
    if (forced) {
      if (lm) badSince = 0;
      else { if (!badSince) badSince = now; if (now - badSince > 1500) { resetHold(); toast('Step into the picture first'); } }
    } else if (c.ok) {
      if (!holdStart) { holdStart = now; speak('Hold still'); }
      badSince = 0;
    } else if (holdStart) {
      if (!badSince) badSince = now;
      if (now - badSince > 400) resetHold();
    }
    const gone = holdStart ? now - holdStart : 0;
    const n = holdStart ? clamp(Math.ceil((COUNT_MS - gone) / 1000), 1, Math.ceil(COUNT_MS / 1000)) : 0;
    if (n !== shownCount) { shownCount = n; countEl.textContent = n || ''; pctEl.textContent = n || ''; if (n) beep(n === 1); }
    setRing(gone / COUNT_MS);
    setHint(holdStart ? '' : c.hint);
    // someone who cannot get the photo taken for 45 seconds: note which hint they kept seeing
    if (c.hint) hintCount[c.hint] = (hintCount[c.hint] || 0) + 1;
    if (!stuckSent && now - stepStart > 45000) {
      stuckSent = true;
      const top = Object.entries(hintCount).sort((a, b) => b[1] - a[1])[0];
      reportProblem('tryon.capture_stuck', top ? top[0] : 'no hint shown', { photo: step, back_camera: rear });
    }
    titleEl.textContent = holdStart ? 'Hold still…' : step === 'front' ? 'Face the camera' : 'Now turn around';
    if (holdStart && gone >= COUNT_MS && lm && (forced || c.ok)) capture(lm);
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
  function check(lm, dt = 0.033) {
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
    // from behind, the shoulders swap sides or the face is hidden
    const faceVis = Math.max(lm[0].visibility, lm[2].visibility, lm[5].visibility);
    const facing = lm[11].x > lm[12].x && faceVis > 0.5 ? 'front' : 'back';
    if (!squareOn || facing !== step) return { ok: false, hint: step === 'front' ? 'Turn to face the camera' : 'Turn around so your back faces the camera' };
    const cx = (lm[11].x + lm[12].x + lm[23].x + lm[24].x) / 4, cy = (sy + hy) / 2;
    const moved = prev ? Math.hypot(cx - prev.x, cy - prev.y) : 1;
    prev = { x: cx, y: cy };
    // allowed drift per frame: more on slow phones (fewer frames a second) and when the phone is hand-held
    if (moved > (rear ? 2.2 : 1) * Math.max(0.006, 0.18 * dt)) return { ok: false, hint: performance.now() - stepStart > 2500 ? (rear ? 'Hold the phone steady' : 'Hold still') : '' };
    return { ok: true };
  }

  // keep a clean, portrait crop of the person (2:3) and their joints inside it
  function capture(lm) {
    const vw = video.videoWidth, vh = video.videoHeight;
    const xs = [];
    for (let i = 0; i < 33; i++) if (lm[i].visibility > 0.5) xs.push(lm[i].x * vw);
    if (xs.length < 4) { resetHold(); toast('Step back so we can see you'); return; }
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
    const list = Object.values(photos).filter(Boolean), mine = session;
    let pending = list.length;
    for (const p of list) p.canvas.toBlob((b) => {
      if (mine !== session) return; // closed or retaken meanwhile
      p.url = b ? URL.createObjectURL(b) : null;
      if (--pending === 0) {
        setMode('looks'); show();
        // they picked this outfit in the shop: make the real picture straight away
        if (autoReal && !custom() && API && leftToday() > 0) { autoReal = false; makeReal(); }
      }
    }, 'image/jpeg', 0.92);
    speak('Your photos are ready.', true);
  }

  /* ---------- looks: outfits on the photo ---------- */
  function show() {
    if (!photos[side]) side = 'front';
    const p = photos[side];
    if (!p) return;
    const fab = custom();
    nameEl.textContent = fab ? (cloth ? `${STITCH.wearer[stitch.wearer]} from your fabric` : 'Your own fabric') : ALL[look.style].label;
    sideEl.querySelectorAll('[data-side]').forEach((b) => { b.classList.toggle('active', b.dataset.side === side); b.disabled = !photos[b.dataset.side]; });
    const real = results.get(resultKey());
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
    const left = leftToday(), canReal = !!API && left > 0;
    // The person's own photo is shown as it is. The drawn sketch appears only when asked for,
    // for their own fabric, or when no real try-on is possible.
    const drawn = !real && G && (!fab || cloth) && (sketch || fab || !canReal);
    if (drawn) { dctx.setTransform(dpr, 0, 0, dpr, 0, 0); paintOutfit(dctx, fw, fh, (i) => [p.lm[i].x * fw, p.lm[i].y * fh], side === 'back'); }
    subEl.textContent = fab && !cloth ? 'Add your fabric below' : real ? 'On you' : drawn ? 'Quick sketch' : 'Your photo';
    realBtn.hidden = !API || !!real || (fab && !cloth);
    realBtn.disabled = left <= 0;
    realBtn.textContent = left > 0 ? 'Try it on' : 'No try-ons left today';
    sketchBtn.hidden = !!real || fab || !canReal || !G;
    sketchBtn.classList.toggle('on', sketch);
    leftEl.classList.toggle('warn', !!notice && !real);
    leftEl.textContent = notice && !real ? notice : !API ? 'Real try-on is not switched on yet.'
      : left > 0 ? `${left} free ${left === 1 ? 'try-on' : 'try-ons'} left today` : 'Come back tomorrow for more.';
  }

  // the wait is shown as a countdown; if the picture takes longer, it says so instead of stopping at zero
  function startClock(total) {
    stopClock();
    const t0 = performance.now();
    const tick = () => {
      const left = Math.ceil(total - (performance.now() - t0) / 1000);
      if (left > 0) { secsEl.textContent = left; busy.classList.add('counting'); }
      else { busy.classList.remove('counting'); busy.querySelector('b').textContent = 'Almost there…'; busy.querySelector('small').textContent = ''; }
    };
    tick(); clock = setInterval(tick, 250);
  }
  function stopClock() { clearInterval(clock); clock = 0; busy.classList.remove('counting'); }
  sketchBtn.addEventListener('click', () => { sketch = !sketch; show(); });

  async function makeReal() {
    const p = photos[side];
    if (!API || !p || leftToday() <= 0 || !busy.hidden) return;
    const fab = custom();
    if (fab && !cloth) return;
    const key = resultKey(), sKey = fab ? `${cloth.id}|${stitch.wearer}|${stitch.neck}|${stitch.bottom}` : '';
    const mine = session;
    const person = p.canvas.toDataURL('image/jpeg', 0.9);
    // fabric: the server first stitches a suit from the fabric (kept for the other photo), then puts it on the person
    const payload = fab
      ? { person, side, ...(stitched.has(sKey) ? { garment: stitched.get(sKey) } : { fabric: cloth.data, stitch }) }
      : { person, garment: photoUrl(look.style, 800), style: look.style, side };
    const slow = fab && !stitched.has(sKey);
    const say = (b, small) => { busy.querySelector('b').textContent = b; busy.querySelector('small').textContent = small; };
    notice = '';
    say('Connecting…', '');
    busy.hidden = false; realBtn.disabled = true;
    const ctl = new AbortController();
    let timer = 0, why = '', code = '';
    const began = performance.now();
    try {
      // 1. find a server address this internet connection can reach (some providers block one of them)
      let api = '';
      for (let round = 0; round < 2 && !api; round++) for (const a of APIS) if (await reachable(a)) { api = a; break; }
      if (!api) { code = 'unreachable'; why = 'Your internet connection cannot reach our try-on server. Switch between Wi-Fi and mobile data, then tap See it for real again.'; throw new Error('server unreachable'); }
      API = api;
      // 2. send the photo; give up with a clear message instead of spinning for ever
      say(slow ? 'Stitching your suit' : 'Making your picture', 'seconds');
      startClock(slow ? 40 : 20);
      timer = setTimeout(() => ctl.abort(), slow ? 150000 : 90000);
      const r = await fetch(API, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), signal: ctl.signal,
      });
      const data = await r.json().catch(() => ({}));
      // keep the stitched suit even when the try-on step failed, so a retry does not stitch (and cost) again
      if (fab && data.garment && mine === session) stitched.set(sKey, data.garment);
      const count = () => store.set(dayKey(), String(typeof data.left === 'number' ? DAILY_LIMIT - data.left : used() + 1));
      if (r.status === 429) { store.set(dayKey(), String(DAILY_LIMIT)); toast('You have used today’s real try-ons'); }
      else if (!r.ok || !data.image) {
        if (typeof data.left === 'number') count();
        code = r.status === 502 ? 'ai_failed' : r.status === 503 || r.status === 403 ? 'not_setup' : 'bad_photo';
        why = r.status === 502 ? 'The AI could not make this picture. Try again, or retake the photo with your whole body in view and good light.'
          : r.status === 503 || r.status === 403 ? 'The try-on server is not set up for this site yet.'
          : 'The photo could not be used. Retake it and try again.';
        throw new Error(data.error || `Server said ${r.status}`);
      } else {
        count();
        // 3. make sure the finished picture really opens on this connection; if not, fetch it through our server
        stopClock(); say('Almost there…', '');
        const viaUs = `${API}?img=${encodeURIComponent(data.image)}`;
        const shown = (await loads(data.image)) ? data.image : (await loads(viaUs)) ? viaUs : '';
        if (!shown) { code = 'result_no_load'; why = 'Your picture was made, but it would not load on this internet connection. Switch between Wi-Fi and mobile data and try again.'; throw new Error('result did not load'); }
        // photos retaken or the screen closed meanwhile: this picture is of the old photo, so drop it
        if (mine === session) { results.set(key, shown); if (fab && data.garment) stitched.set(sKey, data.garment); }
        sendProblems(); // the server is reachable now: deliver any notes that were waiting
      }
    } catch (e) {
      console.warn('AI try-on failed', e);
      reportProblem(`tryon.${code || (ctl.signal.aborted ? 'timeout' : 'dropped')}`, String(e && e.message || e), { outfit: fab ? 'my fabric' : look.style, photo: side, seconds: Math.round((performance.now() - began) / 1000) });
      if (mine === session) {
        notice = why || (ctl.signal.aborted ? 'This took too long, so we stopped. Your internet connection may be slow or blocking the try-on server. Try again on Wi-Fi or mobile data.'
          : 'The connection dropped while your picture was being made. Check your internet and try again.');
        notice += ' We have noted this problem so it can be fixed.';
        toast('Could not make the picture');
      }
    }
    clearTimeout(timer);
    if (mine !== session) return;
    stopClock();
    busy.hidden = true;
    if (stage.classList.contains('open') && stage.dataset.mode === 'looks') show();
  }

  async function savePicture() {
    const p = photos[side]; if (!p) return;
    const real = results.get(resultKey());
    const name = `miraal-${custom() ? 'my-fabric' : look.style}-${side}.jpg`;
    const save = (blob) => { const u = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 60000); };
    // on an iPhone the share sheet (Save Image) is the way into the photo gallery; elsewhere a normal download
    const download = async (blob) => {
      const apple = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      if (apple) {
        try {
          const file = new File([blob], name, { type: 'image/jpeg' });
          if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file] }); return; }
        } catch (e) { if (e && e.name === 'AbortError') return; }
      }
      save(blob);
    };
    if (real) {
      // the AI picture lives on another site; if the browser may not read it directly, fetch it through the Miraal server
      const grab = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(String(r.status)); return r.blob(); };
      try { await download(await grab(real).catch(() => grab(`${API}?img=${encodeURIComponent(real)}`))); } catch { window.open(real, '_blank', 'noopener'); }
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
      const p = ALL[look.style];
      G.paintFabric(art.getContext('2d'), 512, 512, hex, look.pattern || 'plain', { circ: 2 * Math.PI * 0.3 * 0.87, len: G.topMax(p) - p.bottom });
      swatch.getContext('2d').drawImage(art, 150, 190, 128, 128, 0, 0, 128, 128); // a border-free piece for sleeves
    }
    swatchPattern = ctx.createPattern(swatch, 'repeat');
  }

  function paintOutfit(ctx, cw, ch, P, isBack) {
    const fab = custom() && cloth;
    const p = styleNow();
    const hex = fab ? cloth.avg : COLORS[look.color].hex;
    if (!fab) ensureArt(ctx, hex);

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
    const formHalf = (y) => G.garmentBaseR(p, 0.013, y) * (1 + 0.42 * G.bump(y, 0.8, 0.985));
    // men's cuts fall straight from the chest; women's follow the dress-form shape
    const half = (y) => (p.cut === 'straight' && y < 0.8 ? 0.305 + (p.flare || 0) * clamp((0.8 - y) / (0.8 - p.bottom), 0, 1) : formHalf(y) * (y < 0.8 ? 0.84 : 0.94)) * ux;
    // the customer's own fabric, repeated at a believable print size
    let clothPat = null;
    if (fab) { clothPat = ctx.createPattern(cloth.tile, 'repeat'); const k = (1.15 * sw) / 512; clothPat.setTransform(new DOMMatrix().scale(k, k)); }
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
      const legHex = p.trousers.color || shade(hex, p.bottom > -0.2 ? 0.0 : 0.08);
      for (const [h, k, a] of [[23, 25, 27], [24, 26, 28]]) {
        const hip = mix(P(h), Hp, 0.15), knee = P(k), ank = mix(knee, P(a), 0.97);
        const pts = [hip, mix(hip, knee, 0.5), knee, mix(knee, ank, 0.55), mix(knee, ank, 0.9), ank];
        const w = GATHERED.includes(p.trousers.kind)
          ? [W[0], W[0] * 1.02, W[1], W[1] * 0.92, W[2] * 1.25, W[2]]
          : [W[0], lerp(W[0], W[1], 0.5), W[1], lerp(W[1], W[2], 0.55), lerp(W[1], W[2], 0.9), W[2]];
        softShadow(); ctx.fillStyle = legHex; tube(pts, w.map((x) => x * sw * 0.88)); ctx.fill(); noShadow();
        ctx.save(); ctx.clip();
        if (clothPat && p.gender === 'men') { ctx.fillStyle = clothPat; ctx.fillRect(0, 0, cw, ch); }
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
        if (ri === 0 && p.neck && p.neck.shape === 'v' && !isBack) { ctx.lineTo(...axis(y0 - dip)); ctx.lineTo(...Lp[0]); }
        else ctx.quadraticCurveTo(...axis(y0 - dip * 2), ...Lp[0]);
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
    if (fab) { ctx.fillStyle = clothPat; ctx.fillRect(-maxHW, -0.05 * T, 2 * maxHW, L2 + 0.1 * T); }
    else if (isBack) ctx.drawImage(art, 128, 0, 256, 512, -maxHW, -0.02 * T, 2 * maxHW, L2);
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

    /* front buttons */
    if (p.placket != null && !isBack) {
      const a = axis(top - (p.neck ? p.neck.dip : 0)), b = axis(Math.max(p.placket, bot + 0.02));
      ctx.strokeStyle = 'rgba(0,0,0,.28)'; ctx.lineWidth = Math.max(1.5, sw * 0.008); ctx.lineCap = 'butt';
      ctx.beginPath(); ctx.moveTo(...add(a, u, sw * 0.022)); ctx.lineTo(...add(b, u, sw * 0.022)); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,.75)'; ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 1;
      const n = Math.max(3, Math.round(len(sub(b, a)) / (sw * 0.3)));
      for (let i = 0; i < n; i++) { const c = mix(a, b, (i + 0.6) / n); ctx.beginPath(); ctx.arc(c[0], c[1], Math.max(1.6, sw * 0.012), 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
    }

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
        const w0 = s.r0 * 2 * ux, w1 = s.r1 * 2 * ux;
        const widths = pts.length === 2 ? [w0, lerp(w0, w1, 0.6)] : [w0, lerp(w0, w1, 0.5), w1];
        softShadow(); ctx.fillStyle = hex; const end = tube(pts, widths); ctx.fill(); noShadow();
        ctx.save(); ctx.clip();
        const sleevePat = fab ? clothPat : (look.pattern && look.pattern !== 'plain' ? swatchPattern : null);
        if (sleevePat) { ctx.fillStyle = sleevePat; ctx.fillRect(0, 0, cw, ch); }
        ctx.strokeStyle = 'rgba(0,0,0,.22)'; ctx.lineWidth = Math.max(4, w0 * 0.28); tube(pts, widths); ctx.stroke();
        if (dark > 0) { ctx.fillStyle = `rgba(0,0,0,${dark})`; ctx.fillRect(0, 0, cw, ch); }
        ctx.restore();
        if (!fab && look.pattern && look.pattern !== 'plain') { ctx.strokeStyle = GOLD; ctx.lineWidth = Math.max(3, sw * 0.02); ctx.lineCap = 'butt'; ctx.beginPath(); ctx.moveTo(...end.endA); ctx.lineTo(...end.endB); ctx.stroke(); }
      }
    }

    /* waistcoat over the kameez */
    if (p.vest) {
      const vb = p.vest.bottom, vTop = 0.975, vDeep = 0.5;
      const panel = (sgn) => {
        ctx.beginPath(); ctx.moveTo(...edge(vTop, sgn));
        for (let i = 1; i <= 14; i++) { const y = lerp(vTop, vb, i / 14); ctx.lineTo(...add(axis(y), across(y), sgn * half(y) * 1.03)); }
        if (isBack) { for (let i = 14; i >= 0; i--) { const y = lerp(vTop, vb, i / 14); ctx.lineTo(...add(axis(y), across(y), -sgn * half(y) * 1.03)); } }
        else { ctx.lineTo(...add(axis(vb), u, sgn * sw * 0.015)); ctx.lineTo(...add(axis(vDeep), u, sgn * sw * 0.015)); }
        ctx.closePath();
      };
      for (const sgn of isBack ? [1] : [-1, 1]) {
        softShadow(); ctx.fillStyle = p.vest.color; panel(sgn); ctx.fill(); noShadow();
        ctx.save(); ctx.clip();
        const vg = ctx.createLinearGradient(...add(axis(0.5), u, -half(0.5)), ...add(axis(0.5), u, half(0.5)));
        vg.addColorStop(0, 'rgba(0,0,0,.34)'); vg.addColorStop(0.5, 'rgba(255,255,255,.07)'); vg.addColorStop(1, 'rgba(0,0,0,.34)');
        ctx.fillStyle = vg; ctx.fillRect(0, 0, cw, ch);
        ctx.restore();
      }
      if (!isBack) { ctx.fillStyle = GOLD; for (let i = 0; i < 4; i++) { const c = add(axis(lerp(vDeep - 0.04, vb + 0.05, i / 3)), u, -sw * 0.03); ctx.beginPath(); ctx.arc(c[0], c[1], Math.max(1.8, sw * 0.013), 0, Math.PI * 2); ctx.fill(); } }
    }

    /* collar */
    if (p.collar && !isBack) {
      const dip = p.neck ? p.neck.dip : 0.03, nl = edge(top, -1), nr = edge(top, 1), nc = axis(top - dip);
      const colHex = G.mixHex(hex, G.lightness(hex) > 0.6 ? '#000000' : '#ffffff', 0.1);
      if (p.collar === 'ban') {
        ctx.strokeStyle = colHex; ctx.lineWidth = Math.max(4, sw * 0.045); ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(...nl); ctx.quadraticCurveTo(...axis(top - dip * 2), ...nr); ctx.stroke();
        ctx.strokeStyle = 'rgba(0,0,0,.25)'; ctx.lineWidth = 1; ctx.stroke();
      } else {
        for (const [edgePt, sgn] of [[nl, -1], [nr, 1]]) {
          ctx.beginPath(); ctx.moveTo(...edgePt); ctx.lineTo(...nc); ctx.lineTo(...add(axis(top - dip - 0.085), u, sgn * half(top) * 0.8)); ctx.closePath();
          ctx.fillStyle = colHex; ctx.fill(); ctx.strokeStyle = 'rgba(0,0,0,.3)'; ctx.lineWidth = 1; ctx.stroke();
        }
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
