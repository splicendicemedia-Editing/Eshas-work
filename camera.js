// Guided live body scan.
// - Consent first, then the browser's own camera permission prompt.
// - Full-screen stage: live precaution checklist, spoken + on-screen turning guidance
//   (front -> side -> back -> other side), live measurements drawn on the body.
// - MediaPipe Pose Landmarker (+ person segmentation mask) runs locally in the browser.
//   Frames are never stored or uploaded; the camera is switched off and cleared when the scan ends.
// Measurements: height you enter gives the scale (cm per pixel of your silhouette). Front/back
// silhouette widths and side depths at neck / chest / waist / hips / thigh are combined as
// ellipse circumferences. These are estimates, not tailor-grade values.

const $ = (s) => document.querySelector(s);
const VISION_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task';

const BONES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28]];
const JOINTS = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
const PRIOR = { shoulder: 0.238, bust: 0.514, waist: 0.406, hips: 0.56, inseam: 0.452, arm: 0.343, neck: 0.205, thigh: 0.322 };
const DEPTH_RATIO = { neck: 0.95, bust: 0.72, waist: 0.76, hips: 0.8, thigh: 1.0 };
const CIRC_FACTOR = { neck: 1.0, bust: 1.05, waist: 1.0, hips: 1.0, thigh: 1.0 };
const ROW_KEYS = ['neck', 'bust', 'waist', 'hips', 'thigh'];
const ROW_LABEL = { neck: 'Neck', bust: 'Chest', waist: 'Waist', hips: 'Hips', thigh: 'Thigh' };
const LIVE_KEYS = [['height', 'Height'], ['shoulder', 'Shoulders'], ['bust', 'Chest / bust'], ['waist', 'Waist'], ['hips', 'Hips'], ['inseam', 'Inseam'], ['arm', 'Arm length'], ['neck', 'Neck'], ['thigh', 'Thigh']];

const PHASES = [
  { id: 'ready', title: 'Get set up', sub: 'Follow the checklist — the scan starts by itself when everything is green.',
    say: "Let's get you set up. Prop your phone or laptop at waist height, then stand about two metres back so your whole body is visible." },
  { id: 'front', need: 'front', hold: 36, arms: true, title: 'Face the camera', sub: 'Arms slightly away from your body · feet hip-width apart · hold still',
    say: 'Face the camera. Hold your arms slightly away from your body, feet hip width apart, and hold still.' },
  { id: 'side1', need: 'side', hold: 30, turn: true, title: 'Turn a quarter to your left', sub: 'Your side faces the camera · arms relaxed · look straight ahead',
    say: 'Great. Now turn a quarter to your left, so your side faces the camera. Arms relaxed by your sides. Hold still.' },
  { id: 'back', need: 'back', hold: 24, turn: true, arms: true, title: 'Keep turning — back to the camera', sub: 'Arms slightly out again · hold still',
    say: 'Keep turning to your left until your back faces the camera. Arms slightly out, and hold still.' },
  { id: 'side2', need: 'side2', hold: 30, turn: true, title: 'Keep turning — show your other side', sub: 'Arms relaxed · hold still',
    say: 'Almost done. Keep turning so your other side faces the camera, and hold still.' },
  { id: 'done', title: 'All done', sub: '' },
];

const lerp = (a, b, t) => a + (b - a) * t;
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const avg = (...v) => { const x = v.filter((n) => n != null && isFinite(n)); return x.length ? x.reduce((s, n) => s + n, 0) / x.length : null; };
const ellipse = (w, d) => { const a = w / 2, b = d / 2; return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b))); };

export function initCamera({ getHeight, setHeight, onMeasured, onSave, onStage, toast }) {
  /* ---------- elements ---------- */
  const camBtn = $('#camBtn');
  const consent = $('#consentModal'), agree = $('#consentAgree'), allow = $('#consentAllow');
  const stage = $('#scanStage'), video = $('#ssVideo'), canvas = $('#ssCanvas'), ctx = canvas.getContext('2d');
  const titleEl = $('#ssTitle'), subEl = $('#ssSub'), ring = $('#ssRing'), pctEl = $('#ssPct'), turnEl = $('#ssTurn');
  const skipBtn = $('#ssSkip'), voiceBtn = $('#ssVoice'), heightIn = $('#ssHeight'), liveList = $('#ssLiveList');
  const doneEl = $('#ssDone'), resultEl = $('#ssResult'), hintEl = $('#ssHint');

  liveList.innerHTML = LIVE_KEYS.map(([k, l]) => `<div data-k="${k}"><dt>${l}</dt><dd><b>—</b><i></i></dd></div>`).join('');

  /* ---------- state ---------- */
  let stream = null, landmarker = null, raf = 0, lastT = -1, frameNo = 0;
  let maskBuf = null, mw = 0, mh = 0;
  const tint = document.createElement('canvas'), tctx = tint.getContext('2d');
  const lightCv = document.createElement('canvas'); lightCv.width = 40; lightCv.height = 24;
  const lctx = lightCv.getContext('2d', { willReadFrequently: true });
  let lum = 128, prevHip = null, stillCount = 0;
  let pi = 0, hold = 0, samples = [], phaseStart = 0, side1Dir = 0;
  let captured = {}, liveW = {}, liveD = {}, liveLen = {};
  let voiceOn = true, lastSpoken = 0, lastHint = '', hintSince = 0;

  /* ---------- consent ---------- */
  const openConsent = () => { agree.checked = false; allow.disabled = true; consent.classList.add('open'); setTimeout(() => agree.focus(), 50); };
  const closeConsent = () => consent.classList.remove('open');
  camBtn.addEventListener('click', openConsent);
  document.querySelectorAll('[data-open-camera]').forEach((b) => b.addEventListener('click', (e) => {
    e.preventDefault(); $('#measure').scrollIntoView({ behavior: 'smooth' }); setTimeout(openConsent, 600);
  }));
  agree.addEventListener('change', () => { allow.disabled = !agree.checked; });
  consent.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeConsent));
  consent.addEventListener('click', (e) => { if (e.target === consent) closeConsent(); });
  allow.addEventListener('click', () => { closeConsent(); start(); });
  $('#saveMeasure')?.addEventListener('click', () => onSave());

  /* ---------- stage controls ---------- */
  $('#ssStop').addEventListener('click', () => { const wasLive = !!stream; stopCamera(); closeStage(); if (wasLive) toast('Camera off · nothing was saved'); });
  $('#ssClose').addEventListener('click', closeStage);
  $('#ssAgain').addEventListener('click', () => start());
  $('#ssSaveProfile').addEventListener('click', () => { closeStage(); onSave(); });
  skipBtn.addEventListener('click', () => { capture(PHASES[pi], true); nextPhase(); });
  voiceBtn.addEventListener('click', () => {
    voiceOn = !voiceOn; voiceBtn.setAttribute('aria-pressed', voiceOn); voiceBtn.classList.toggle('on', voiceOn);
    if (!voiceOn) speechSynthesis?.cancel();
  });
  heightIn.addEventListener('input', () => { const h = parseFloat(heightIn.value); if (h >= 130 && h <= 215) setHeight(h); });
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && stage.classList.contains('open')) { stopCamera(); closeStage(); } });

  function speak(text, force) {
    if (!voiceOn || !('speechSynthesis' in window) || !text) return;
    const now = performance.now();
    if (!force && now - lastSpoken < 6500) return;
    lastSpoken = now;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text); u.rate = 1.02; u.lang = 'en-US';
    speechSynthesis.speak(u);
  }

  function openStage() {
    stage.classList.add('open'); document.body.classList.add('scan-open');
    doneEl.hidden = true; stage.dataset.phase = 'ready';
    onStage && onStage(true);
  }
  function closeStage() {
    stage.classList.remove('open'); document.body.classList.remove('scan-open');
    speechSynthesis?.cancel();
    onStage && onStage(false);
  }

  /* ---------- start ---------- */
  async function start() {
    heightIn.value = Math.round(getHeight());
    resetScan();
    openStage();
    setGuide('Waiting for camera permission…', 'Your browser is asking to use the camera — choose Allow.');
    if (!navigator.mediaDevices?.getUserMedia) {
      setGuide('Camera not available here', 'Open this page in Chrome, Edge or Safari on localhost or https.');
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    } catch (e) {
      stream = null;
      setGuide(e && e.name === 'NotAllowedError' ? 'Camera permission was declined' : 'No camera found',
        e && e.name === 'NotAllowedError' ? 'Nothing was captured. Allow the camera in the address bar to try again.' : 'Connect a camera or close other apps that are using it.');
      return;
    }
    video.srcObject = stream;
    await video.play().catch(() => {});
    setGuide('Loading body tracker…', 'About 10 MB the first time, then it is cached.');
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

  async function loadLandmarker() {
    const vision = await import(`${VISION_URL}/vision_bundle.mjs`);
    const files = await vision.FilesetResolver.forVisionTasks(`${VISION_URL}/wasm`);
    const opts = (delegate) => ({ baseOptions: { modelAssetPath: MODEL_URL, delegate }, runningMode: 'VIDEO', numPoses: 1, outputSegmentationMasks: true });
    try { return await vision.PoseLandmarker.createFromOptions(files, opts('GPU')); }
    catch { return vision.PoseLandmarker.createFromOptions(files, opts('CPU')); }
  }

  function resetScan() {
    pi = 0; hold = 0; samples = []; side1Dir = 0; captured = {}; liveW = {}; liveD = {}; liveLen = {};
    prevHip = null; stillCount = 0; frameNo = 0; lastT = -1; lastHint = '';
    liveList.querySelectorAll('[data-k]').forEach((r) => { r.className = ''; r.querySelector('b').textContent = '—'; });
    stage.querySelectorAll('.ss-steps li').forEach((li) => li.classList.remove('done', 'active'));
  }

  function enterPhase(i) {
    pi = i; hold = 0; samples = []; phaseStart = performance.now();
    const ph = PHASES[i];
    stage.dataset.phase = ph.id;
    stage.querySelectorAll('.ss-steps li').forEach((li, k) => { li.classList.toggle('done', k < i); li.classList.toggle('active', k === i); });
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
  function setRing(p) { ring.style.setProperty('--p', Math.round(p * 100)); pctEl.textContent = p > 0 ? `${Math.round(p * 100)}%` : ''; }
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

  /* ---------- mask helpers ---------- */
  function extent(cxN) {
    const c0 = Math.max(0, Math.round((cxN - 0.07) * mw)), c1 = Math.min(mw - 1, Math.round((cxN + 0.07) * mw));
    let top = -1, bot = -1;
    for (let y = 0; y < mh; y += 2) {
      const o = y * mw;
      for (let x = c0; x <= c1; x += 2) if (maskBuf[o + x] > 0.5) { if (top < 0) top = y; bot = y; break; }
    }
    return top < 0 ? null : { top: top / mh, bottom: Math.min(1, (bot + 2) / mh) };
  }
  function run(yN, cxN) {
    if (!(yN > 0 && yN < 1)) return null;
    const yc = Math.round(yN * (mh - 1));
    let sum = 0, L = 0, R = 0, n = 0;
    for (let dy = -2; dy <= 2; dy++) {
      const y = yc + dy; if (y < 0 || y >= mh) continue;
      const o = y * mw;
      let c = Math.round(Math.min(1, Math.max(0, cxN)) * (mw - 1));
      if (maskBuf[o + c] < 0.5) {
        let f = -1; const lim = Math.round(mw * 0.03);
        for (let d = 1; d <= lim; d++) {
          if (c + d < mw && maskBuf[o + c + d] >= 0.5) { f = c + d; break; }
          if (c - d >= 0 && maskBuf[o + c - d] >= 0.5) { f = c - d; break; }
        }
        if (f < 0) continue; c = f;
      }
      let l = c, r = c;
      while (l > 0 && maskBuf[o + l - 1] >= 0.5) l--;
      while (r < mw - 1 && maskBuf[o + r + 1] >= 0.5) r++;
      sum += r - l + 1; L += l; R += r + 1; n++;
    }
    return n ? { w: sum / n / mw, l: L / n / mw, r: R / n / mw, y: yN } : null;
  }
  function crotchY(cxN, bottomN, hipN) {
    const c = Math.round(cxN * (mw - 1));
    let y = Math.min(mh - 1, Math.round(bottomN * mh) - 3);
    if (maskBuf[y * mw + c] >= 0.5) return null; // legs together: no gap to find
    const stop = Math.round(hipN * mh);
    while (y > stop && maskBuf[y * mw + c] < 0.5) y--;
    return y <= stop ? null : y / mh;
  }

  /* ---------- analysis ---------- */
  function analyse(lm) {
    const f = { present: !!lm, checks: {}, runs: {}, cm: null };
    const H = getHeight();
    f.checks.height = H >= 130 && H <= 215;
    // a white wall is fine; only flag clearly dark or blown-out frames
    f.checks.light = lum > 45 && lum < 248;
    f.lightHint = lum <= 45 ? 'Too dark — switch on a light in front of you' : lum >= 248 ? 'Too bright — avoid standing in front of a window' : '';
    if (!lm || !maskBuf) { f.checks.body = false; f.checks.distance = false; f.checks.still = false; f.checks.arms = false; return f; }

    const vw = video.videoWidth, vh = video.videoHeight;
    const vis = (i) => lm[i].visibility > 0.5;
    const sx = (lm[11].x + lm[12].x) / 2, sy = (lm[11].y + lm[12].y) / 2;
    const hx = (lm[23].x + lm[24].x) / 2, hy = (lm[23].y + lm[24].y) / 2;
    const T = hy - sy;
    const swN = Math.abs(lm[11].x - lm[12].x);
    const ratio = (swN * vw) / Math.max(1, Math.abs(T) * vh);
    // facing the camera: face visible and the person's left shoulder (11) on the image's right
    const faceVis = Math.max(lm[0].visibility, lm[2].visibility, lm[5].visibility);
    f.orient = ratio < 0.42 ? 'side' : ratio > 0.58 ? (lm[11].x > lm[12].x && faceVis > 0.5 ? 'front' : 'back') : 'turning';
    f.dir = lm[0].x > hx ? 1 : -1;

    const ext = extent(hx);
    f.ext = ext;
    const frac = ext ? ext.bottom - ext.top : 0;
    f.checks.body = !!ext && ext.top > 0.012 && ext.bottom < 0.988 && (vis(27) || vis(28)) && (vis(11) || vis(12));
    f.checks.distance = frac >= 0.5 && frac <= 0.93;
    f.bodyHint = !ext ? 'Step into the frame' : ext.top <= 0.012 ? 'Your head is cut off — step back or tilt the camera up'
      : ext.bottom >= 0.988 || !(vis(27) || vis(28)) ? 'Your feet are cut off — step back a little' : '';
    f.distHint = frac > 0.93 ? 'Step back a little' : frac < 0.5 ? 'Come a bit closer' : '';

    const wristOut = (w, h) => Math.abs(lm[w].x - lm[h].x) > 0.28 * swN && lm[w].y > sy;
    f.checks.arms = wristOut(15, 23) && wristOut(16, 24);

    if (prevHip) {
      const mv = Math.hypot(hx - prevHip.x, hy - prevHip.y);
      stillCount = mv < 0.006 ? stillCount + 1 : 0;
    }
    prevHip = { x: hx, y: hy };
    f.checks.still = stillCount >= 3;
    if (!ext || !f.checks.height) return f;

    // scale: entered height over silhouette height in pixels
    const statPx = frac * vh;
    const cmPx = H / statPx;
    const isSide = f.orient === 'side';
    const mouthY = (lm[9].y + lm[10].y) / 2;
    const kneeY = (lm[25].y + lm[26].y) / 2;
    const earX = avg(vis(7) ? lm[7].x : null, vis(8) ? lm[8].x : null) ?? sx;
    const rows = {
      neck: [mouthY + 0.4 * (sy - mouthY), isSide ? lerp(earX, sx, 0.6) : sx],
      bust: [sy + 0.3 * T, lerp(sx, hx, 0.3)],
      waist: [sy + 0.64 * T, lerp(sx, hx, 0.64)],
      hips: [hy + 0.06 * T, hx],
      thigh: [hy + 0.3 * (kneeY - hy), isSide ? hx : lerp(lm[23].x, lm[25].x, 0.3)],
    };
    const cm = {};
    for (const k of ROW_KEYS) {
      const r = run(rows[k][0], rows[k][1]);
      if (r) { f.runs[k] = r; cm[k] = r.w * vw * cmPx; }
    }
    if (!isSide) {
      // arms touching the torso make the chest/waist silhouette too wide
      const merged = f.runs.bust && f.runs.bust.w > 1.25 * swN;
      if (merged) { f.checks.arms = false; delete cm.bust; delete cm.waist; }
      // legs touching: the thigh run spans both legs
      if (cm.thigh && cm.hips && cm.thigh > 0.62 * cm.hips) { delete cm.thigh; f.legsTogether = true; }
      const d = (a, b) => Math.hypot((lm[a].x - lm[b].x) * vw, (lm[a].y - lm[b].y) * vh);
      cm.shoulder = swN * vw * cmPx * 1.18;
      cm.arm = ((d(11, 13) + d(13, 15) + d(12, 14) + d(14, 16)) / 2) * cmPx * 1.05;
      const ankleY = (lm[27].y + lm[28].y) / 2;
      let cy = crotchY(hx, ext.bottom, hy);
      if (cy == null || cy > hy + 0.35 * (ankleY - hy)) cy = hy + 0.1 * (ankleY - hy);
      cm.inseam = (ext.bottom - cy) * vh * cmPx;
    }
    f.cm = cm;
    return f;
  }

  /* ---------- phase logic ---------- */
  function step(f) {
    const ph = PHASES[pi];
    if (!ph || ph.id === 'done') return;
    const envOk = f.checks.height && f.checks.body && f.checks.distance && f.checks.light;
    const envHint = !f.checks.height ? 'Enter your height so we can scale your measurements'
      : !f.present ? 'Step into the frame — we can’t see you yet'
      : f.bodyHint || f.distHint || f.lightHint;

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
      const ok = envOk && f.checks.still;
      hold = ok ? hold + 1 : Math.max(0, hold - 1);
      setRing(hold / 30);
      setHint(ok ? '' : envHint || (!f.checks.still ? 'Stand still for a moment' : ''));
      if (hold >= 30) nextPhase();
      return;
    }

    let match = false;
    if (ph.need === 'front') match = f.orient === 'front';
    else if (ph.need === 'back') match = f.orient === 'back';
    else if (ph.need === 'side') match = f.orient === 'side';
    else if (ph.need === 'side2') match = f.orient === 'side' && (side1Dir === 0 || f.dir !== side1Dir || performance.now() - phaseStart > 9000);

    const ok = match && envOk && (!ph.arms || f.checks.arms) && f.checks.still && f.cm;
    if (ok) { hold++; samples.push(f.cm); } else hold = Math.max(0, hold - 1);
    if (ph.need === 'side' && match && f.checks.still) side1Dir = f.dir;
    setRing(hold / ph.hold);
    turnEl.classList.toggle('show', !!ph.turn && !match);

    let hint = '';
    if (!match) hint = f.orient === 'turning' ? 'Keep turning slowly…' : ph.title;
    else if (!envOk) hint = envHint;
    else if (ph.arms && !f.checks.arms) hint = 'Move your arms out so they don’t touch your body';
    else if (ph.arms && f.legsTogether) hint = 'Stand with your feet hip-width apart';
    else if (!f.checks.still) hint = 'Hold still…';
    setHint(hint);
    setGuide(ok ? 'Hold still — measuring' : ph.title, ph.sub);

    if (performance.now() - phaseStart > 15000) skipBtn.hidden = false;
    if (hold >= ph.hold) { capture(ph, false); nextPhase(); }
  }

  function capture(ph, skipped) {
    const take = (k) => median(samples.map((s) => s[k]).filter((v) => v != null));
    const got = {};
    for (const k of [...ROW_KEYS, 'shoulder', 'arm', 'inseam']) { const v = take(k); if (v != null) got[k] = v; }
    captured[ph.id] = skipped ? { skipped: true } : got;
    if (ph.id === 'side1' && !skipped) side1Dir = side1Dir || 1;
    if (!skipped) speak(ph.id === 'front' ? 'Got it.' : 'Nice.', true);
  }

  function compute(final) {
    const H = getHeight();
    const fr = captured.front || {}, bk = captured.back || {}, s1 = captured.side1 || {}, s2 = captured.side2 || {};
    const clampP = (k, v) => (v == null ? null : Math.min(H * PRIOR[k] * 1.3, Math.max(H * PRIOR[k] * 0.7, v)));
    const out = { height: H };
    const state = { height: 'ok' };
    for (const k of ROW_KEYS) {
      const w = avg(fr[k], bk[k]) ?? (final ? null : liveW[k]);
      const dCap = avg(s1[k], s2[k]);
      const d = dCap ?? (final ? null : liveD[k]) ?? (w ? w * DEPTH_RATIO[k] : null);
      out[k] = w ? clampP(k, ellipse(w, d) * CIRC_FACTOR[k]) : (final ? H * PRIOR[k] : null);
      state[k] = (fr[k] || bk[k]) && dCap ? 'ok' : w ? 'est' : '';
    }
    for (const k of ['shoulder', 'arm', 'inseam']) {
      const v = fr[k] ?? bk[k] ?? (final ? null : liveLen[k]);
      out[k] = v ? clampP(k, v) : (final ? H * PRIOR[k] : null);
      state[k] = fr[k] || bk[k] ? 'ok' : v ? 'est' : '';
    }
    return { out, state };
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
    const armsRelevant = !!PHASES[pi]?.arms || PHASES[pi]?.id === 'ready';
    set('height', f.checks.height, 'Enter 130–215 cm');
    set('body', f.checks.body, f.bodyHint || 'Step into view');
    set('distance', f.checks.distance, f.distHint || 'Stand about 2 m away');
    set('light', f.checks.light, f.lightHint);
    set('arms', armsRelevant ? f.checks.arms : true, 'Arms slightly out to the sides');
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

    // live measurement lines across the silhouette
    const { out } = compute(false);
    const side = f.orient === 'side';
    for (const k of ROW_KEYS) {
      const r = f.runs[k]; if (!r) continue;
      const [xa, y] = M(r.l, r.y), [xb] = M(r.r, r.y);
      ctx.strokeStyle = '#e2c08d'; ctx.lineWidth = 1.6; ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(xa, y); ctx.lineTo(xb, y); ctx.stroke(); ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(xa, y - 6); ctx.lineTo(xa, y + 6); ctx.moveTo(xb, y - 6); ctx.lineTo(xb, y + 6); ctx.stroke();
      const val = out[k] ? `${ROW_LABEL[k]} ${out[k].toFixed(1)} cm` : ROW_LABEL[k];
      const extra = f.cm?.[k] ? ` · ${side ? 'depth' : 'width'} ${f.cm[k].toFixed(1)}` : '';
      // xa is the body's right edge on screen (canvas mirrored)
      label(Math.min(xa, xb) - 12, y, val + extra, 'start');
    }
  }

  /* ---------- finish / stop ---------- */
  function finish() {
    const { out } = compute(true);
    const result = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, Math.round(v * 10) / 10]));
    stopCamera();
    stage.dataset.phase = 'done';
    stage.querySelectorAll('.ss-steps li').forEach((li) => { li.classList.add('done'); li.classList.remove('active'); });
    resultEl.innerHTML = LIVE_KEYS.map(([k, l]) => `<div><dt>${l}</dt><dd>${result[k].toFixed(1)}<span>cm</span></dd></div>`).join('');
    const skippedAny = Object.values(captured).some((c) => c.skipped);
    $('#ssDoneNote').textContent = skippedAny
      ? 'Some steps were skipped, so a few values are estimated from body proportions.'
      : 'Estimates from your silhouette — re-scan in fitted clothes for best results.';
    doneEl.hidden = false;
    speak('All done. Your camera is now off, and no pictures were saved.', true);
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
    turnEl.classList.remove('show'); setHint('');
  }

  // never leave the camera running in the background
  document.addEventListener('visibilitychange', () => { if (document.hidden && stream) { stopCamera(); setGuide('Scan paused', 'The camera turned off because you left the tab. Nothing was saved.'); } });
  addEventListener('pagehide', () => { if (stream) stopCamera(); });
}
