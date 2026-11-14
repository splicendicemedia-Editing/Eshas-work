// Guided live body scan.
// - Simple setup card first (height in cm or ft/in, three set-up tips, privacy promise),
//   then the browser's own camera permission prompt.
// - Full-screen stage: one big instruction at a time, spoken + on screen, turning guidance
//   (front -> side -> back -> other side), quick checks, optional live measurements panel.
// - MediaPipe Pose Landmarker (+ person mask) runs locally in the browser. Frames are never
//   stored or uploaded; the camera is switched off and cleared when the scan ends.
// - The measuring maths (incl. protection against background objects) lives in measure.js.

import { measureFrame, combine, turnWidths, fromTurn, ROW_KEYS } from './measure.js?v=27';
import { recommendSize, whoFor, setWhoFor } from './profile.js?v=27';
import { reportProblem } from './report.js?v=27';
import { UNIT, fmtLen, withUnit, heightText, useUnits, heightToCm, heightBox } from './units.js?v=27';

const $ = (s) => document.querySelector(s);
const VISION_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task';

const BONES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28]];
const JOINTS = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
const ROW_LABEL = { neck: 'Neck', bust: 'Chest', waist: 'Waist', hips: 'Hips', thigh: 'Thigh' };
const LIVE_KEYS = [['height', 'Height'], ['bust', 'Chest / bust'], ['waist', 'Waist'], ['hips', 'Hips'], ['shoulder', 'Shoulders'], ['inseam', 'Inseam'], ['arm', 'Arm length'], ['neck', 'Neck'], ['thigh', 'Thigh']];

const PHASES = [
  { id: 'ready', title: 'Step back', sub: 'Head to toe in the picture',
    say: 'Stand your phone up at waist height, then take about three big steps back, so I can see you from head to toe.' },
  { id: 'front', need: 'front', hold: 36, arms: true, title: 'Face the camera', sub: 'Stand relaxed and hold still',
    say: 'Face the camera, stand relaxed, and hold still.' },
  { id: 'spin', turn: true, title: 'Turn around slowly', sub: 'One full turn · hands on your head',
    say: 'Great. Now put your hands on your head.' },
  { id: 'done', title: 'All done', sub: '' },
];
const STEP_NAME = { front: 'Front', spin: 'Turn', side1: 'Side', back: 'Back', side2: 'Other side' };
const CAM_KEY = 'mirra.cam'; // 'user' (front camera) or 'environment' (back camera, someone else holds the phone)
const READY_SAY_REAR = 'Hold the phone upright at about waist height, three big steps away, so I can see the whole person from head to toe.';

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
  const flipBtn = $('#ssFlip'), camBtns = consent.querySelectorAll('[data-cam]');

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
  let camWant = 'user', rear = false, flipping = false, camRun = 0, badFrames = 0, stuckSent = false;
  let lastLm = null, scales = [], scaleRef = null, spin = [], spinStage = 0, turnRes = null; // the turn-around step
  let spinMax = 0, spinArmed = 0, armsUpRun = 0;
  let who = whoFor(); // whose size chart: 'women' or 'men'

  /* ---------- setup card: height (cm or ft/in) + consent ---------- */
  function setUnit(u) {
    unit = u; store.set('mirra.unit', u);
    useUnits(u); // results are shown in the same units the person chose for their height
    consent.querySelectorAll('[data-unit]').forEach((b) => b.classList.toggle('on', b.dataset.unit === u));
    consent.querySelector('.h-cm').hidden = u !== 'cm';
    consent.querySelector('.h-ft').hidden = u !== 'ft';
    fillHeight(getHeight());
  }
  function fillHeight(h) {
    hCm.value = heightBox(h);
    const totalIn = h / 2.54;
    let ft = Math.floor(totalIn / 12), inch = Math.round(totalIn - ft * 12);
    if (inch === 12) { ft++; inch = 0; }
    hFt.value = ft; hIn.value = inch;
  }
  function readHeight() {
    if (unit === 'cm') return heightToCm(hCm.value);
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

  const whoBtns = consent.querySelectorAll('[data-who]');
  const syncWho = () => whoBtns.forEach((b) => b.classList.toggle('on', b.dataset.who === who));
  whoBtns.forEach((b) => b.addEventListener('click', () => { who = b.dataset.who; setWhoFor(who); syncWho(); }));
  function syncCam() {
    camBtns.forEach((b) => b.classList.toggle('on', b.dataset.cam === camWant));
    const back = camWant === 'environment';
    $('#setupPhoneB').textContent = back ? 'Someone holds the phone' : 'Stand your phone up';
    $('#setupPhoneS').textContent = back ? 'upright, at waist height, with the back camera facing you' : 'at waist height, against something steady';
  }
  camBtns.forEach((b) => b.addEventListener('click', () => { camWant = b.dataset.cam; store.set(CAM_KEY, camWant); syncCam(); }));
  flipBtn.addEventListener('click', flip);
  const openConsent = () => { who = whoFor(); syncWho(); setUnit(unit); camWant = store.get(CAM_KEY) === 'environment' ? 'environment' : 'user'; syncCam(); hErr.textContent = ''; consent.classList.add('open'); };
  const closeConsent = () => consent.classList.remove('open');
  camBtn?.addEventListener('click', openConsent);
  document.querySelectorAll('[data-open-camera]').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); openConsent(); }));
  consent.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeConsent));
  consent.addEventListener('click', (e) => { if (e.target === consent) closeConsent(); });
  allow.addEventListener('click', () => {
    const h = readHeight();
    if (!(h >= 130 && h <= 215)) {
      hErr.textContent = unit === 'cm' ? 'Please enter a height between 1.30 and 2.15 m' : 'Please enter a height between 4 ft 4 in and 7 ft 0 in';
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
  $('#ssTry').addEventListener('click', () => { closeStage(); onTry && onTry(lastResult?.size?.size, !!lastResult?.measured); });
  skipBtn.addEventListener('click', () => { if (!stream) return; capture(PHASES[pi], true); nextPhase(); }); // nothing to skip once the camera is off
  voiceBtn.addEventListener('click', () => {
    voiceOn = !voiceOn; voiceBtn.setAttribute('aria-pressed', voiceOn); voiceBtn.classList.toggle('on', voiceOn);
    if (!voiceOn) window.speechSynthesis?.cancel();
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
    // cancelling when nothing is playing makes some phones drop the next sentence
    if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel();
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
    window.speechSynthesis?.cancel(); // some in-app browsers have no speech at all
    onStage && onStage(false);
  }

  /* ---------- start ---------- */
  async function start() {
    if (stream) stopCamera();
    resetScan();
    openStage();
    setGuide('Waiting for the camera…', 'Your phone is asking to use the camera — tap Allow.');
    if (!navigator.mediaDevices?.getUserMedia) {
      reportProblem('scan.no_camera_api', 'This browser gives the page no camera');
      setGuide('Camera not available here', 'Open this page in Chrome or Safari (it needs a secure https link).');
      return;
    }
    const run = ++camRun;
    let s;
    try {
      s = await openStream();
    } catch (e) {
      if (run !== camRun) return;
      stream = null;
      const denied = e && e.name === 'NotAllowedError';
      reportProblem(denied ? 'scan.camera_denied' : 'scan.camera_failed', `${e && e.name}: ${e && e.message}`);
      setGuide(denied ? 'Camera permission was declined' : 'No camera found',
        denied ? 'Nothing was captured. Allow the camera in your browser settings and try again.' : 'Close other apps that are using the camera and try again.');
      return;
    }
    // stopped while the phone was still asking for permission: switch the camera straight off again
    if (run !== camRun) { s.getTracks().forEach((t) => t.stop()); return; }
    stream = s;
    video.srcObject = stream;
    await video.play().catch(() => {});
    keepAwake();
    if (!needsMotionPrompt) addEventListener('deviceorientation', onOrient);
    setGuide('Getting ready…', 'Loading the body tracker — a few seconds the first time.');
    try { landmarker = landmarker || (await loadLandmarker()); }
    catch (e) {
      console.warn('Pose model failed to load', e);
      reportProblem('scan.tracker_load', String(e && e.message || e));
      if (run !== camRun) return;
      stopCamera(); // do not leave the camera on behind an error message
      setGuide('Body tracker could not load', 'Check your internet connection, tap ✕ Stop, then try again.');
      return;
    }
    if (run !== camRun || !stream) return;
    navigator.mediaDevices.enumerateDevices?.().then((d) => { flipBtn.hidden = d.filter((x) => x.kind === 'videoinput').length < 2; }).catch(() => {});
    enterPhase(0);
    loop();
  }

  async function openStream() {
    const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: camWant, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    const track = s.getVideoTracks()[0], set = track?.getSettings?.() || {};
    // the selfie camera is shown like a mirror; the back camera is shown as it is
    rear = set.facingMode ? set.facingMode === 'environment' : /back|rear|environment/i.test(track?.label || '');
    stage.classList.toggle('rear', rear);
    return s;
  }
  async function flip() {
    if (!stream || flipping || !landmarker) return;
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
    if (!s) { stopCamera(); setGuide('The camera could not be switched', 'Tap ✕ Stop, then start again.'); return; }
    if (camWant === before) toast('The other camera could not be opened');
    store.set(CAM_KEY, camWant);
    stream = s; video.srcObject = s;
    await video.play().catch(() => {});
    if (run !== camRun) return;
    // the step being measured starts again with the new camera; finished steps are kept
    hold = 0; samples = []; scales = []; prevHip = null; stillCount = 0; lastT = -1; phaseStart = performance.now();
    setRing(0);
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
    skipBtn.hidden = true;
    scales = []; scaleRef = null; spin = []; spinStage = 0; turnRes = null; lastLm = null; spinMax = 0; spinArmed = 0; armsUpRun = 0;
    pi = 0; hold = 0; samples = []; side1Dir = 0; captured = {}; liveW = {}; liveD = {}; liveLen = {}; lastResult = null;
    prevHip = null; stillCount = 0; frameNo = 0; lastT = -1; lastHint = ''; phoneTilt = null;
    liveList.querySelectorAll('[data-k]').forEach((r) => { r.className = ''; r.querySelector('b').textContent = '—'; });
    stage.querySelectorAll('.ss-dots li').forEach((li) => li.classList.remove('done', 'active'));
  }

  function enterPhase(i) {
    pi = i; hold = 0; samples = []; phaseStart = performance.now(); stuckSent = false;
    const ph = PHASES[i];
    stage.dataset.phase = ph.id;
    stage.querySelectorAll('.ss-dots li').forEach((li, k) => { li.classList.toggle('done', k + 1 < i); li.classList.toggle('active', k + 1 === i); });
    stepNo.textContent = i === 0 ? 'Getting ready' : `${i} of 2 · ${STEP_NAME[ph.id]}`;
    setGuide(ph.title, ph.sub);
    setRing(0);
    skipBtn.hidden = true;
    speak(ph.id === 'ready' && rear ? READY_SAY_REAR : ph.say, true);
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
    try { res = landmarker.detectForVideo(video, performance.now()); }
    catch (e) {
      console.warn(e);
      // the tracker failing on every picture would otherwise leave the person waiting forever
      if (++badFrames > 40) { reportProblem('scan.tracker_crash', String(e && e.message || e)); stopCamera(); setGuide('The body tracker stopped working', 'Tap ✕ Stop and try again. If it keeps happening, open this page in Chrome or Safari.'); }
      return;
    }
    badFrames = 0;
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
    lastLm = lm || null;
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
    f.uprightHint = !phoneOk ? (rear ? 'Hold the phone straight up — it is leaning' : 'Stand your phone up straight — it is leaning')
      : !f.checks.upright ? 'Your phone looks tilted — straighten it so you stand upright on screen' : '';
    f.checks.upright = f.checks.upright && phoneOk;

    const hx = (lm[23].x + lm[24].x) / 2, hy = (lm[23].y + lm[24].y) / 2;
    // a hand-held phone (back camera) is allowed a little more shake
    if (prevHip) stillCount = Math.hypot(hx - prevHip.x, hy - prevHip.y) < (rear ? 0.013 : 0.006) ? stillCount + 1 : 0;
    prevHip = { x: hx, y: hy };
    f.checks.still = stillCount >= 3;
    return f;
  }

  /* ---------- phase logic ---------- */
  function step(f) {
    const ph = PHASES[pi];
    if (!ph || ph.id === 'done') return;
    // someone who cannot get past a step for 40 seconds: note which hint they kept seeing
    if (!stuckSent && performance.now() - phaseStart > 40000) { stuckSent = true; reportProblem('scan.step_stuck', lastHint || 'no hint shown', { step: ph.id, back_camera: rear }); }
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

    if (ph.id === 'spin') { stepSpin(ph, f); return; }

    let match = false;
    if (ph.need === 'front') match = f.orient === 'front';
    else if (ph.need === 'back') match = f.orient === 'back';
    else if (ph.need === 'side') match = f.orient === 'side';
    else if (ph.need === 'side2') match = f.orient === 'side' && (side1Dir === 0 || f.dir !== side1Dir || performance.now() - phaseStart > 9000);

    const ok = match && envOk && (!ph.arms || c.arms) && c.still && f.cm;
    if (ok) { hold++; samples.push(f.cm); } else hold = Math.max(0, hold - 1);
    // the size reference for the turn comes from any good front frame, even if this step is skipped
    if (ph.need === 'front' && match && envOk && f.scale) scales.push(f.scale);
    if (ph.need === 'side' && match && c.still) side1Dir = f.dir;
    setRing(hold / ph.hold);
    turnEl.classList.toggle('show', !!ph.turn && !match);

    let hint = '';
    if (!f.present) hint = envHint;
    else if (!match) hint = f.orient === 'turning' ? (ph.need === 'front' ? 'Turn to face the camera' : 'Keep turning slowly…') : ph.title;
    else if (!envOk) hint = envHint;
    else if (ph.arms && !c.arms) hint = 'Hands by your sides, not in front of you';
    else if (!c.still) hint = 'Hold still…';
    setHint(hint);
    setGuide(ok ? 'Hold still…' : ph.title, ok ? 'Measuring' : ph.sub);

    if (performance.now() - phaseStart > 15000) skipBtn.hidden = false;
    if (hold >= ph.hold) { capture(ph, false); nextPhase(); }
  }

  // Turn-around step: collect what every angle shows; done when the person is facing the camera again.
  function stepSpin(ph, f) {
    // a full turn = wide (facing), narrow (side-on), wide (back), narrow, wide again. Wide and narrow are
    // judged against the widest this person has looked, so it works for any build and with arms up.
    const SEQ = ['wide', 'narrow', 'wide', 'narrow', 'wide'];
    const now = performance.now();
    const t = f.present && lastLm && maskBuf ? turnWidths(lastLm, maskBuf, { mw, mh, vw: video.videoWidth, vh: video.videoHeight, torso: scaleRef && scaleRef.torso }) : null;
    let hint = '';
    if (!f.present) hint = 'Stay in the picture, head to toe';
    else if (!f.checks.light) hint = f.lightHint;
    else if (!t) hint = 'Stay in the picture, head to toe';
    else if (!spinArmed) {
      // wait for the hands to go up (it keeps the arms out of the measurement); after 10 seconds carry on anyway
      armsUpRun = t.armsUp ? armsUpRun + 1 : 0;
      if (armsUpRun >= 6 || now - phaseStart > 10000) { spinArmed = now; speak('Now turn all the way around, slowly.', true); }
    } else {
      spin.push(t);
      // the widest this person looks, ignoring the odd glitched frame
      if (spin.length < 8 || spin.length % 3 === 0) { const rs = spin.map((s) => s.ratio).sort((a, b) => a - b); spinMax = rs[Math.floor(rs.length * 0.9)]; }
      const at = t.ratio > 0.8 * spinMax ? 'wide' : t.ratio < 0.55 * spinMax ? 'narrow' : '';
      if (spin.length > 5 && at === SEQ[spinStage + 1]) spinStage++;
      if (spinStage === 0 && now - spinArmed > 5000) hint = 'Turn around, slowly';
    }
    setRing(spinStage / 4);
    turnEl.classList.toggle('show', !!spinArmed && spinStage === 0);
    setHint(hint);
    setGuide(spinArmed ? ph.title : 'Hands on your head', spinArmed ? (t && !t.armsUp ? 'Hands on your head is more exact' : 'One full turn') : 'Then turn around slowly');
    if (now - phaseStart > 15000) skipBtn.hidden = false;
    if (spinStage >= 4) { finishSpin(false); nextPhase(); }
  }
  function finishSpin(skipped) {
    turnRes = fromTurn(spin, scaleRef);
    captured.spin = turnRes.mode === 'none' ? { skipped: true } : { mode: turnRes.mode };
    if (turnRes.mode === 'none') reportProblem('scan.turn_not_used', `${spin.length} frames, ${turnRes.angles} of 9 angles, skipped ${skipped}`);
    if (!skipped) speak('Nice.', true);
  }

  function capture(ph, skipped) {
    if (ph.id === 'spin') { finishSpin(skipped); return; }
    // a skipped step still keeps whatever good frames it collected
    const usable = !skipped || samples.length >= 6;
    const take = (k) => median(samples.map((s) => s[k]).filter((v) => v != null));
    const got = {};
    if (usable) for (const k of [...ROW_KEYS, 'shoulder', 'arm', 'inseam']) { const v = take(k); if (v != null) got[k] = v; }
    captured[ph.id] = usable && Object.keys(got).length ? got : { skipped: true };
    if (ph.id === 'side1' && usable) side1Dir = side1Dir || 1;
    if (ph.id === 'front' && scales.length) {
      const mid = (k) => median(scales.map((s) => s[k]));
      scaleRef = { cmPx: mid('cmPx'), leg: mid('leg'), torso: mid('torso') };
    }
    if (!skipped) speak(ph.id === 'front' ? 'Got it.' : 'Nice.', true);
  }

  function compute(final) {
    return combine({ height: getHeight(), front: captured.front, back: captured.back, side1: turnRes ? turnRes.depth : captured.side1, side2: captured.side2,
      around: turnRes ? turnRes.around : {}, liveW, liveD, liveLen, final, who });
  }

  function renderLive() {
    const { out, state } = compute(false);
    for (const [k] of LIVE_KEYS) {
      const row = liveList.querySelector(`[data-k="${k}"]`);
      if (!row) continue;
      row.querySelector('b').textContent = out[k] ? (k === 'height' ? heightText(out[k]) : withUnit(out[k])) : '—';
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
    set('distance', f.checks.distance, f.distHint || 'Step back about 3 big steps');
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
    ctx.translate(x, y); if (!rear) ctx.scale(-1, 1); // the selfie view is mirrored by CSS; flip text back
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
      const val = blocked ? `${ROW_LABEL[k]} · blocked` : out[k] ? `${ROW_LABEL[k]} ${withUnit(out[k])}` : ROW_LABEL[k];
      const extra = !blocked && f.cm?.[k] ? ` · ${side ? 'depth' : 'width'} ${fmtLen(f.cm[k])}` : '';
      if (rear) label(Math.max(xa, xb) + 12, y, val + extra, 'start'); else label(Math.min(xa, xb) - 12, y, val + extra, 'start');
    }
  }

  /* ---------- finish / stop ---------- */
  function finish() {
    const { out, capped } = compute(true);
    const result = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, Math.round(v * 10) / 10]));
    stopCamera();
    stage.dataset.phase = 'done';
    stage.querySelectorAll('.ss-dots li').forEach((li) => { li.classList.add('done'); li.classList.remove('active'); });
    stepNo.textContent = 'Done';
    const size = recommendSize(result, who);
    lastResult = { result, size };
    // only claim a measured size when chest and hips were really captured (front view, or all the way round in the turn)
    const fb = [captured.front, captured.back].filter((c) => c && !c.skipped);
    const measured = (fb.some((c) => c.bust) && fb.some((c) => c.hips)) || !!(turnRes && turnRes.mode === 'around');
    lastResult.measured = measured;
    const label = who === 'men' ? 'Men’s size' : 'Women’s size';
    $('#ssSize').innerHTML = !size ? '<small>Your measurements</small>'
      : measured ? `<small>${label}</small><b>${size.size}</b><span>EU ${size.eu} · based on your ${who === 'men' ? 'chest and waist' : 'chest, waist and hips'}</span>`
      : `<small>Estimated ${label.toLowerCase()}</small><b>${size.size}</b><span>EU ${size.eu} · guessed from your height only. Scan again for your real size</span>`;
    $('#ssTry').textContent = size ? `Shop in size ${size.size}` : 'Back to the shop';
    resultEl.innerHTML = LIVE_KEYS.map(([k, l]) => (k === 'height' ? `<div><dt>${l}</dt><dd>${heightText(result[k])}</dd></div>`
      : `<div><dt>${l}</dt><dd>${fmtLen(result[k])}<span>${UNIT}</span></dd></div>`)).join('');
    const skippedAny = Object.values(captured).some((c) => c.skipped);
    const skippedIds = Object.entries(captured).filter(([, c]) => c.skipped).map(([k]) => k);
    if (skippedIds.length) reportProblem('scan.steps_skipped', skippedIds.join(', '));
    if (capped.length) reportProblem('scan.value_limited', capped.join(', '), { height: Math.round(getHeight()) });
    if (!measured) reportProblem('scan.size_guessed', 'chest and hips were not captured');
    $('#ssDoneNote').textContent = skippedAny
      ? 'Some steps were skipped, so a few numbers are estimated from your height.'
      : turnRes && turnRes.mode === 'around' ? 'Chest, waist and hips were measured all the way round you. These are still estimates from your outline.'
      : turnRes && turnRes.mode === 'side' ? 'Chest, waist and hips come from your front and side. For the most exact result, scan again with your hands on your head while you turn.'
      : capped.length ? 'One or more numbers came out far from what is usual for your height, so they were limited. Loose clothes or things behind you can cause this. Scan again in fitted clothes.'
      : 'These are estimates from your outline. For the best result, scan in fitted clothes.';
    doneEl.hidden = false;
    speak(size ? `All done. Your size is ${size.size}. Your camera is now off, and no pictures were saved.` : 'All done. Your camera is now off, and no pictures were saved.', true);
    onMeasured(result, measured);
  }

  function stopCamera() {
    camRun++;
    cancelAnimationFrame(raf);
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null; badFrames = 0; flipBtn.hidden = true;
    video.pause(); video.srcObject = null;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height);
    canvas.width = canvas.height = 0;
    if (maskBuf) maskBuf.fill(0);
    maskBuf = null; tint.width = tint.height = 1;
    lctx.clearRect(0, 0, 40, 24);
    removeEventListener('deviceorientation', onOrient);
    wakeLock?.release?.().catch?.(() => {}); wakeLock = null;
    turnEl.classList.remove('show'); setHint(''); skipBtn.hidden = true;
  }

  // never leave the camera running in the background
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && stream) { stopCamera(); setGuide('Scan paused', 'The camera turned off because you left the page. Nothing was saved. Tap ✕ Stop, then start again.'); }
  });
  addEventListener('pagehide', () => { if (stream) stopCamera(); });
}
