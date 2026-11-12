// Guided live body scan.
// - Simple setup card first (height in cm or ft/in, three set-up tips, privacy promise),
//   then the browser's own camera permission prompt.
// - Full-screen stage: one big instruction at a time, spoken + on screen, turning guidance
//   (front -> side -> back -> other side), quick checks, optional live measurements panel.
// - MediaPipe Pose Landmarker (+ person mask) runs locally in the browser. Frames are never
//   stored or uploaded; the camera is switched off and cleared when the scan ends.
// - The measuring maths (incl. protection against background objects) lives in measure.js.

import { measureFrame, combine, ROW_KEYS } from './measure.js?v=10';
import { recommendSize } from './profile.js?v=10';

const $ = (s) => document.querySelector(s);
const VISION_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task';

const BONES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28]];
const JOINTS = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
const ROW_LABEL = { neck: 'Neck', bust: 'Chest', waist: 'Waist', hips: 'Hips', thigh: 'Thigh' };
const LIVE_KEYS = [['height', 'Height'], ['bust', 'Chest / bust'], ['waist', 'Waist'], ['hips', 'Hips'], ['shoulder', 'Shoulders'], ['inseam', 'Inseam'], ['arm', 'Arm length'], ['neck', 'Neck'], ['thigh', 'Thigh']];

const PHASES = [
  { id: 'ready', title: 'Step back until we see all of you', sub: 'Head to toe in the picture · about 2 m away',
    say: 'Stand your phone up at waist height, then step back about two metres, so I can see you from head to toe.' },
  { id: 'front', need: 'front', hold: 36, arms: true, title: 'Face the camera', sub: 'Arms a little away from your body · feet apart',
    say: 'Face the camera. Hold your arms a little away from your body, feet apart, and stay still.' },
  { id: 'side1', need: 'side', hold: 30, turn: true, title: 'Turn to your left', sub: 'Stop when your side faces the camera',
    say: 'Great. Now turn to your left, and stop when your side faces the camera.' },
  { id: 'back', need: 'back', hold: 24, turn: true, arms: true, title: 'Keep turning — back to the camera', sub: 'Arms a little out again',
    say: 'Keep turning left until your back faces the camera. Arms a little out.' },
  { id: 'side2', need: 'side2', hold: 30, turn: true, title: 'One more turn', sub: 'Stop when your other side faces the camera',
    say: 'Last one. Keep turning until your other side faces the camera.' },
  { id: 'done', title: 'All done', sub: '' },
];
const STEP_NAME = { front: 'Front', side1: 'Side', back: 'Back', side2: 'Other side' };

const lerp = (a, b, t) => a + (b - a) * t;
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* blocked */ } } };

export function initCamera({ getHeight, setHeight, onMeasured, onSave, onTry, onStage, toast }) {
  /* ---------- elements ---------- */
  const camBtn = $('#camBtn');
  const consent = $('#consentModal'), allow = $('#consentAllow');
  const hCm = $('#setupH'), hFt = $('#setupFt'), hIn = $('#setupIn'), hErr = $('#setupErr');
  const stage = $('#scanStage'), video = $('#ssVideo'), canvas = $('#ssCanvas'), ctx = canvas.getContext('2d');
  const titleEl = $('#ssTitle'), subEl = $('#ssSub'), ring = $('#ssRing'), pctEl = $('#ssPct'), turnEl = $('#ssTurn');
  const skipBtn = $('#ssSkip'), voiceBtn = $('#ssVoice'), liveBtn = $('#ssLiveToggle'), liveList = $('#ssLiveList');
  const doneEl = $('#ssDone'), resultEl = $('#ssResult'), hintEl = $('#ssHint'), stepNo = $('#ssStepNo');

  liveList.innerHTML = LIVE_KEYS.map(([k, l]) => `<div data-k="${k}"><dt>${l}</dt><dd><b>—</b><i></i></dd></div>`).join('');

  /* ---------- state ---------- */
  let stream = null, landmarker = null, raf = 0, lastT = -1, frameNo = 0, wakeLock = null;
  let maskBuf = null, mw = 0, mh = 0;
  const tint = document.createElement('canvas'), tctx = tint.getContext('2d');
  const lightCv = document.createElement('canvas'); lightCv.width = 40; lightCv.height = 24;
  const lctx = lightCv.getContext('2d', { willReadFrequently: true });
  let lum = 128, prevHip = null, stillCount = 0, phoneTilt = null;
  let pi = 0, hold = 0, samples = [], phaseStart = 0, side1Dir = 0;
  let captured = {}, liveW = {}, liveD = {}, liveLen = {}, lastResult = null;
  let voiceOn = true, lastSpoken = 0, lastHint = '', hintSince = 0;
  let unit = store.get('mirra.unit') === 'ft' ? 'ft' : 'cm';

  /* ---------- setup card: height (cm or ft/in) + consent ---------- */
  function setUnit(u) {
    unit = u; store.set('mirra.unit', u);
    consent.querySelectorAll('[data-unit]').forEach((b) => b.classList.toggle('on', b.dataset.unit === u));
    consent.querySelector('.h-cm').hidden = u !== 'cm';
    consent.querySelector('.h-ft').hidden = u !== 'ft';
    fillHeight(getHeight());
  }
  function fillHeight(h) {
    hCm.value = Math.round(h);
    const totalIn = h / 2.54;
    let ft = Math.floor(totalIn / 12), inch = Math.round(totalIn - ft * 12);
    if (inch === 12) { ft++; inch = 0; }
    hFt.value = ft; hIn.value = inch;
  }
  function readHeight() {
    if (unit === 'cm') return parseFloat(hCm.value);
    const ft = parseFloat(hFt.value), inch = parseFloat(hIn.value || '0');
    return isFinite(ft) ? (ft * 12 + (isFinite(inch) ? inch : 0)) * 2.54 : NaN;
  }
  consent.querySelectorAll('[data-unit]').forEach((b) => b.addEventListener('click', () => setUnit(b.dataset.unit)));
  [hCm, hFt, hIn].forEach((el) => el.addEventListener('input', () => { hErr.textContent = ''; }));
  $('#privacyMore').addEventListener('click', (e) => {
    const list = $('#privacyList'); list.hidden = !list.hidden;
    e.currentTarget.setAttribute('aria-expanded', String(!list.hidden));
    e.currentTarget.textContent = list.hidden ? 'More' : 'Less';
  });

  const openConsent = () => { setUnit(unit); hErr.textContent = ''; consent.classList.add('open'); };
  const closeConsent = () => consent.classList.remove('open');
  camBtn?.addEventListener('click', openConsent);
  document.querySelectorAll('[data-open-camera]').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); openConsent(); }));
  consent.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeConsent));
  consent.addEventListener('click', (e) => { if (e.target === consent) closeConsent(); });
  allow.addEventListener('click', () => {
    const h = readHeight();
    if (!(h >= 130 && h <= 215)) {
      hErr.textContent = unit === 'cm' ? 'Please enter a height between 130 and 215 cm' : 'Please enter a height between 4 ft 3 in and 7 ft 1 in';
      (unit === 'cm' ? hCm : hFt).focus();
      return;
    }
    setHeight(h);
    unlockSpeech(); // phones only allow speech that starts from a tap
    closeConsent();
    start();
  });
  $('#saveMeasure')?.addEventListener('click', () => onSave());

  /* ---------- stage controls ---------- */
  $('#ssStop').addEventListener('click', () => { const wasLive = !!stream; stopCamera(); closeStage(); if (wasLive) toast('Camera off · nothing was saved'); });
  $('#ssClose').addEventListener('click', closeStage);
  $('#ssAgain').addEventListener('click', () => start());
  $('#ssSaveProfile').addEventListener('click', () => { closeStage(); onSave(); });
  $('#ssTry').addEventListener('click', () => { closeStage(); onTry && onTry(lastResult?.size?.size); });
  skipBtn.addEventListener('click', () => { capture(PHASES[pi], true); nextPhase(); });
  voiceBtn.addEventListener('click', () => {
    voiceOn = !voiceOn; voiceBtn.setAttribute('aria-pressed', voiceOn); voiceBtn.classList.toggle('on', voiceOn);
    if (!voiceOn) speechSynthesis?.cancel();
  });
  const setLive = (on) => { stage.classList.toggle('show-live', on); liveBtn.classList.toggle('on', on); liveBtn.setAttribute('aria-pressed', on); };
  liveBtn.addEventListener('click', () => setLive(!stage.classList.contains('show-live')));
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && stage.classList.contains('open')) { stopCamera(); closeStage(); } });

  function unlockSpeech() {
    try { if ('speechSynthesis' in window) { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); } } catch { /* ignore */ }
  }
  function speak(text, force) {
    if (!voiceOn || !('speechSynthesis' in window) || !text) return;
    const now = performance.now();
    if (!force && now - lastSpoken < 6500) return;
    lastSpoken = now;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text); u.rate = 1.0; u.lang = 'en-US';
    speechSynthesis.speak(u);
  }

  // phone tilt (Android/desktop give this without a prompt; we never trigger the iOS motion prompt)
  const onOrient = (e) => {
    if (e.beta == null) return;
    const landscape = Math.abs(screen.orientation?.angle ?? window.orientation ?? 0) === 90;
    phoneTilt = landscape ? 90 - Math.abs(e.gamma) : Math.abs(e.beta - 90);
  };
  const needsMotionPrompt = typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function';

  function openStage() {
    stage.classList.add('open'); document.body.classList.add('scan-open');
    doneEl.hidden = true; stage.dataset.phase = 'ready';
    setLive(innerWidth >= 900);
    onStage && onStage(true);
  }
  function closeStage() {
    stage.classList.remove('open'); document.body.classList.remove('scan-open');
    speechSynthesis?.cancel();
    onStage && onStage(false);
  }

  /* ---------- start ---------- */
  async function start() {
    resetScan();
    openStage();
    setGuide('Waiting for the camera…', 'Your phone is asking to use the camera — tap Allow.');
    if (!navigator.mediaDevices?.getUserMedia) {
      setGuide('Camera not available here', 'Open this page in Chrome or Safari (it needs a secure https link).');
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    } catch (e) {
      stream = null;
      const denied = e && e.name === 'NotAllowedError';
      setGuide(denied ? 'Camera permission was declined' : 'No camera found',
        denied ? 'Nothing was captured. Allow the camera in your browser settings and try again.' : 'Close other apps that are using the camera and try again.');
      return;
    }
    video.srcObject = stream;
    await video.play().catch(() => {});
    keepAwake();
    if (!needsMotionPrompt) addEventListener('deviceorientation', onOrient);
    setGuide('Getting ready…', 'Loading the body tracker — a few seconds the first time.');
    try { landmarker = landmarker || (await loadLandmarker()); }
    catch (e) {
      console.warn('Pose model failed to load', e);
      setGuide('Body tracker could not load', 'Check your internet connection and try again.');
      return;
    }
    if (!stream) return;
    enterPhase(0);
    loop();
  }

  async function keepAwake() {
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { wakeLock = null; }
  }

  async function loadLandmarker() {
    const vision = await import(`${VISION_URL}/vision_bundle.mjs`);
    const files = await vision.FilesetResolver.forVisionTasks(`${VISION_URL}/wasm`);
    const opts = (delegate) => ({ baseOptions: { modelAssetPath: MODEL_URL, delegate }, runningMode: 'VIDEO', numPoses: 1, outputSegmentationMasks: true });
    try { return await vision.PoseLandmarker.createFromOptions(files, opts('GPU')); }
    catch { return vision.PoseLandmarker.createFromOptions(files, opts('CPU')); }
  }

  function resetScan() {
    pi = 0; hold = 0; samples = []; side1Dir = 0; captured = {}; liveW = {}; liveD = {}; liveLen = {}; lastResult = null;
    prevHip = null; stillCount = 0; frameNo = 0; lastT = -1; lastHint = ''; phoneTilt = null;
    liveList.querySelectorAll('[data-k]').forEach((r) => { r.className = ''; r.querySelector('b').textContent = '—'; });
    stage.querySelectorAll('.ss-dots li').forEach((li) => li.classList.remove('done', 'active'));
  }

  function enterPhase(i) {
    pi = i; hold = 0; samples = []; phaseStart = performance.now();
    const ph = PHASES[i];
    stage.dataset.phase = ph.id;
    stage.querySelectorAll('.ss-dots li').forEach((li, k) => { li.classList.toggle('done', k + 1 < i); li.classList.toggle('active', k + 1 === i); });
    stepNo.textContent = i === 0 ? 'Getting ready' : `Step ${i} of 4 · ${STEP_NAME[ph.id]}`;
    setGuide(ph.title, ph.sub);
    setRing(0);
    skipBtn.hidden = true;
    speak(ph.say, true);
  }
  function nextPhase() {
    if (pi + 1 >= PHASES.length - 1) return finish();
    enterPhase(pi + 1);
  }

  function setGuide(t, s) { titleEl.textContent = t; subEl.textContent = s || ''; }
  function setRing(p) { ring.style.setProperty('--p', Math.round(Math.min(1, p) * 100)); pctEl.textContent = p > 0 ? `${Math.round(Math.min(1, p) * 100)}%` : ''; }
  function setHint(text) {
    hintEl.textContent = text || '';
    hintEl.classList.toggle('show', !!text);
    const now = performance.now();
    if (text !== lastHint) { lastHint = text; hintSince = now; return; }
    if (text && now - hintSince > 2200) speak(text);
  }

  /* ---------- per-frame loop ---------- */
  function loop() {
    if (!stream) return;
    raf = requestAnimationFrame(loop);
    if (video.readyState < 2 || video.currentTime === lastT) return;
    lastT = video.currentTime;
    let res;
    try { res = landmarker.detectForVideo(video, performance.now()); } catch (e) { console.warn(e); return; }
    const lm = res.landmarks?.[0];
    const m = res.segmentationMasks?.[0];
    if (m) {
      mw = m.width; mh = m.height;
      const arr = m.getAsFloat32Array();
      if (!maskBuf || maskBuf.length !== arr.length) maskBuf = new Float32Array(arr.length);
      maskBuf.set(arr);
      m.close?.();
    } else maskBuf = null;
    res.close?.();
    frameNo++;
    if (frameNo % 20 === 1) sampleLight();
    const f = analyse(lm);
    draw(lm, f);
    step(f);
    if (frameNo % 3 === 0) { renderChecks(f); renderLive(); }
  }

  function sampleLight() {
    try {
      lctx.drawImage(video, 0, 0, 40, 24);
      const d = lctx.getImageData(0, 0, 40, 24).data;
      let s = 0; for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      lum = s / (d.length / 4);
    } catch { /* ignore */ }
  }

  /* ---------- analysis ---------- */
  function analyse(lm) {
    const H = getHeight();
    const light = lum > 45 && lum < 248;
    const lightHint = lum <= 45 ? 'Too dark — switch on a light in front of you' : lum >= 248 ? 'Too bright — don’t stand in front of a window' : '';
    if (!lm || !maskBuf) {
      prevHip = null; stillCount = 0;
      return { present: false, runs: {}, cm: null, checks: { height: true, light, body: false, distance: false, still: false, arms: false, upright: true, background: true }, lightHint };
    }
    const f = measureFrame(lm, maskBuf, { mw, mh, vw: video.videoWidth, vh: video.videoHeight, height: H });
    f.present = true;
    f.lightHint = lightHint;
    f.checks.height = H >= 130 && H <= 215;
    f.checks.light = light;
    // phone leaning a lot (from the phone's own motion sensor, where available)
    const phoneOk = phoneTilt == null || phoneTilt < 22;
    f.uprightHint = !phoneOk ? 'Stand your phone up straight — it is leaning'
      : !f.checks.upright ? 'Your phone looks tilted — straighten it so you stand upright on screen' : '';
    f.checks.upright = f.checks.upright && phoneOk;

    const hx = (lm[23].x + lm[24].x) / 2, hy = (lm[23].y + lm[24].y) / 2;
    if (prevHip) stillCount = Math.hypot(hx - prevHip.x, hy - prevHip.y) < 0.006 ? stillCount + 1 : 0;
    prevHip = { x: hx, y: hy };
    f.checks.still = stillCount >= 3;
    return f;
  }

  /* ---------- phase logic ---------- */
  function step(f) {
    const ph = PHASES[pi];
    if (!ph || ph.id === 'done') return;
    const c = f.checks;
    const envOk = c.height && c.body && c.distance && c.light && c.upright && c.background;
    const envHint = !f.present ? 'Step into the picture — we can’t see you yet'
      : f.bodyHint || f.distHint || f.uprightHint || f.bgHint || f.lightHint;

    // keep live readouts moving even before capture
    if (f.cm && envOk) {
      const a = 0.18;
      if (f.orient === 'front' || f.orient === 'back') {
        for (const k of ROW_KEYS) if (f.cm[k]) liveW[k] = liveW[k] ? lerp(liveW[k], f.cm[k], a) : f.cm[k];
        for (const k of ['shoulder', 'arm', 'inseam']) if (f.cm[k]) liveLen[k] = liveLen[k] ? lerp(liveLen[k], f.cm[k], a) : f.cm[k];
      } else if (f.orient === 'side') {
        for (const k of ROW_KEYS) if (f.cm[k]) liveD[k] = liveD[k] ? lerp(liveD[k], f.cm[k], a) : f.cm[k];
      }
    }

    if (ph.id === 'ready') {
      const ok = envOk && c.still;
      hold = ok ? hold + 1 : Math.max(0, hold - 1);
      setRing(hold / 30);
      setHint(ok ? '' : envHint || (!c.still ? 'Stand still for a moment' : ''));
      if (hold >= 30) nextPhase();
      return;
    }

    let match = false;
    if (ph.need === 'front') match = f.orient === 'front';
    else if (ph.need === 'back') match = f.orient === 'back';
    else if (ph.need === 'side') match = f.orient === 'side';
    else if (ph.need === 'side2') match = f.orient === 'side' && (side1Dir === 0 || f.dir !== side1Dir || performance.now() - phaseStart > 9000);

    const ok = match && envOk && (!ph.arms || c.arms) && c.still && f.cm;
    if (ok) { hold++; samples.push(f.cm); } else hold = Math.max(0, hold - 1);
    if (ph.need === 'side' && match && c.still) side1Dir = f.dir;
    setRing(hold / ph.hold);
    turnEl.classList.toggle('show', !!ph.turn && !match);

    let hint = '';
    if (!match) hint = f.orient === 'turning' ? 'Keep turning slowly…' : ph.title;
    else if (!envOk) hint = envHint;
    else if (ph.arms && !c.arms) hint = 'Move your arms out a little so they don’t touch your body';
    else if (ph.arms && f.legsTogether) hint = 'Stand with your feet apart';
    else if (!c.still) hint = 'Hold still…';
    setHint(hint);
    setGuide(ok ? 'Hold still…' : ph.title, ok ? 'Measuring — don’t move' : ph.sub);

    if (performance.now() - phaseStart > 15000) skipBtn.hidden = false;
    if (hold >= ph.hold) { capture(ph, false); nextPhase(); }
  }

  function capture(ph, skipped) {
    // a skipped step still keeps whatever good frames it collected
    const usable = !skipped || samples.length >= 6;
    const take = (k) => median(samples.map((s) => s[k]).filter((v) => v != null));
    const got = {};
    if (usable) for (const k of [...ROW_KEYS, 'shoulder', 'arm', 'inseam']) { const v = take(k); if (v != null) got[k] = v; }
    captured[ph.id] = usable && Object.keys(got).length ? got : { skipped: true };
    if (ph.id === 'side1' && usable) side1Dir = side1Dir || 1;
    if (!skipped) speak(ph.id === 'front' ? 'Got it.' : 'Nice.', true);
  }

  function compute(final) {
    return combine({ height: getHeight(), front: captured.front, back: captured.back, side1: captured.side1, side2: captured.side2, liveW, liveD, liveLen, final });
  }

  function renderLive() {
    const { out, state } = compute(false);
    for (const [k] of LIVE_KEYS) {
      const row = liveList.querySelector(`[data-k="${k}"]`);
      if (!row) continue;
      row.querySelector('b').textContent = out[k] ? `${out[k].toFixed(1)} cm` : '—';
      row.className = state[k] || '';
    }
  }

  function renderChecks(f) {
    const set = (k, ok, hint) => {
      const li = stage.querySelector(`.ss-checks [data-c="${k}"]`);
      if (!li) return;
      li.classList.toggle('ok', !!ok); li.classList.toggle('bad', !ok);
      const em = li.querySelector('em'); if (em) em.textContent = ok ? '' : hint || '';
    };
    set('body', f.checks.body, f.bodyHint || 'Step into view');
    set('distance', f.checks.distance, f.distHint || 'Stand about 2 m away');
    set('upright', f.checks.upright, f.uprightHint);
    set('background', f.checks.background, f.bgHint);
    set('light', f.checks.light, f.lightHint);
    set('still', f.checks.still, 'Hold still');
  }

  /* ---------- drawing ---------- */
  function mapper() {
    const cw = canvas.clientWidth, ch = canvas.clientHeight, vw = video.videoWidth || 1, vh = video.videoHeight || 1;
    const s = Math.max(cw / vw, ch / vh), dw = vw * s, dh = vh * s, ox = (cw - dw) / 2, oy = (ch - dh) / 2;
    return (nx, ny) => [ox + nx * dw, oy + ny * dh];
  }
  function updateTint() {
    const tw = Math.max(1, mw >> 2), th = Math.max(1, mh >> 2);
    if (tint.width !== tw || tint.height !== th) { tint.width = tw; tint.height = th; }
    const img = tctx.createImageData(tw, th), d = img.data;
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
      const v = maskBuf[(y * 4) * mw + x * 4];
      const i = (y * tw + x) * 4;
      if (v > 0.5) { d[i] = 157; d[i + 1] = 140; d[i + 2] = 255; d[i + 3] = 70; }
    }
    tctx.putImageData(img, 0, 0);
  }
  function label(x, y, text, align) {
    ctx.save();
    ctx.translate(x, y); ctx.scale(-1, 1); // canvas is mirrored by CSS; flip text back
    ctx.font = '600 12px "Inter Tight", system-ui, sans-serif';
    const w = ctx.measureText(text).width + 14;
    const x0 = align === 'end' ? -w : 0;
    ctx.fillStyle = 'rgba(12,10,18,.78)'; ctx.strokeStyle = 'rgba(226,192,141,.6)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x0, -11, w, 22, 11) : ctx.rect(x0, -11, w, 22); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#f3dcb4'; ctx.fillText(text, x0 + 7, 4);
    ctx.restore();
  }
  function draw(lm, f) {
    const dpr = Math.min(devicePixelRatio || 1, 2), cw = canvas.clientWidth, ch = canvas.clientHeight;
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) { canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr); }
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!lm) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const M = mapper();
    if (maskBuf) {
      if (frameNo % 2 === 0 || tint.width <= 1) updateTint();
      const [x0, y0] = M(0, 0), [x1, y1] = M(1, 1);
      ctx.drawImage(tint, x0, y0, x1 - x0, y1 - y0);
    }
    const ok = (i) => lm[i].visibility > 0.5;
    ctx.lineCap = 'round'; ctx.lineWidth = 2.4; ctx.strokeStyle = 'rgba(157,140,255,.95)'; ctx.shadowColor = '#9d8cff'; ctx.shadowBlur = 10;
    for (const [a, b] of BONES) {
      if (!ok(a) || !ok(b)) continue;
      const [x1, y1] = M(lm[a].x, lm[a].y), [x2, y2] = M(lm[b].x, lm[b].y);
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    }
    ctx.fillStyle = '#fff';
    for (const i of JOINTS) { if (!ok(i)) continue; const [x, y] = M(lm[i].x, lm[i].y); ctx.beginPath(); ctx.arc(x, y, 3.6, 0, Math.PI * 2); ctx.fill(); }
    ctx.shadowBlur = 0;

    // live measurement lines across the silhouette (red = blocked by something behind you)
    const { out } = compute(false);
    const side = f.orient === 'side';
    const showText = stage.classList.contains('show-live');
    for (const k of ROW_KEYS) {
      const r = f.runs[k]; if (!r) continue;
      const blocked = r.bled && f.bgBleed?.includes(k);
      const [xa, y] = M(r.l, r.y), [xb] = M(r.r, r.y);
      ctx.strokeStyle = blocked ? '#ff6f7d' : '#e2c08d'; ctx.lineWidth = 1.6; ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(xa, y); ctx.lineTo(xb, y); ctx.stroke(); ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(xa, y - 6); ctx.lineTo(xa, y + 6); ctx.moveTo(xb, y - 6); ctx.lineTo(xb, y + 6); ctx.stroke();
      if (!showText && !blocked) continue;
      const val = blocked ? `${ROW_LABEL[k]} · blocked` : out[k] ? `${ROW_LABEL[k]} ${out[k].toFixed(1)} cm` : ROW_LABEL[k];
      const extra = !blocked && f.cm?.[k] ? ` · ${side ? 'depth' : 'width'} ${f.cm[k].toFixed(1)}` : '';
      label(Math.min(xa, xb) - 12, y, val + extra, 'start');
    }
  }

  /* ---------- finish / stop ---------- */
  function finish() {
    const { out } = compute(true);
    const result = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, Math.round(v * 10) / 10]));
    stopCamera();
    stage.dataset.phase = 'done';
    stage.querySelectorAll('.ss-dots li').forEach((li) => { li.classList.add('done'); li.classList.remove('active'); });
    stepNo.textContent = 'Done';
    const size = recommendSize(result);
    lastResult = { result, size };
    // only claim a measured size when the front or back view really captured chest and hips
    const fb = [captured.front, captured.back].filter((c) => c && !c.skipped);
    const measured = fb.some((c) => c.bust) && fb.some((c) => c.hips);
    $('#ssSize').innerHTML = !size ? '<small>Your measurements</small>'
      : measured ? `<small>Your size</small><b>${size.size}</b><span>EU ${size.eu} · based on your chest, waist and hips</span>`
      : `<small>Estimated size</small><b>${size.size}</b><span>EU ${size.eu} · guessed from your height only — scan again with your arms a little out for your real size</span>`;
    $('#ssTry').textContent = size ? `Try dresses in size ${size.size}` : 'Try dresses';
    resultEl.innerHTML = LIVE_KEYS.map(([k, l]) => `<div><dt>${l}</dt><dd>${result[k].toFixed(1)}<span>cm</span></dd></div>`).join('');
    const skippedAny = Object.values(captured).some((c) => c.skipped);
    $('#ssDoneNote').textContent = skippedAny
      ? 'Some steps were skipped, so a few numbers are estimated from your height.'
      : 'These are estimates from your outline. For the best result, scan in fitted clothes.';
    doneEl.hidden = false;
    speak(size ? `All done. Your size is ${size.size}. Your camera is now off, and no pictures were saved.` : 'All done. Your camera is now off, and no pictures were saved.', true);
    onMeasured(result);
  }

  function stopCamera() {
    cancelAnimationFrame(raf);
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    video.pause(); video.srcObject = null;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height);
    canvas.width = canvas.height = 0;
    if (maskBuf) maskBuf.fill(0);
    maskBuf = null; tint.width = tint.height = 1;
    lctx.clearRect(0, 0, 40, 24);
    removeEventListener('deviceorientation', onOrient);
    wakeLock?.release?.().catch?.(() => {}); wakeLock = null;
    turnEl.classList.remove('show'); setHint('');
  }

  // never leave the camera running in the background
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && stream) { stopCamera(); setGuide('Scan paused', 'The camera turned off because you left the page. Nothing was saved. Tap ✕ Stop, then start again.'); }
  });
  addEventListener('pagehide', () => { if (stream) stopCamera(); });
}
