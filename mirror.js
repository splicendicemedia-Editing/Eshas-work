// Live mirror: try outfits on yourself.
// The front camera is shown like a mirror and the chosen outfit is drawn over the person, following
// their shoulders, hips, knees and ankles (MediaPipe pose, on-device). Nothing is uploaded or stored;
// a picture is only kept if the person takes one and taps Save, and then it is saved by their browser.

import { STYLES, COLORS, photoUrl, lookFor } from './catalog.js?v=15';
import { getLandmarker } from './pose.js?v=15';

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

export function initMirror({ onStage, toast }) {
  const stage = $('#mirrorStage'), video = $('#mrVideo'), canvas = $('#mrCanvas'), ctx = canvas.getContext('2d');
  const startCard = $('#mrStart'), photoCard = $('#mrPhoto'), hintEl = $('#mrHint'), statusEl = $('#mrStatus');
  const rail = $('#mrRail'), colorsEl = $('#mrColors'), nameEl = $('#mrName');

  let stream = null, landmarker = null, G = null, raf = 0, lastT = -1, frameNo = 0, wakeLock = null, shotUrl = null;
  let look = lookFor('shalwar');
  let sm = null, lostFrames = 0, lum = 140;
  const art = document.createElement('canvas'); art.width = art.height = 512;
  const swatch = document.createElement('canvas'); swatch.width = swatch.height = 128;
  let artKey = '', swatchPattern = null;
  const lightCv = document.createElement('canvas'); lightCv.width = lightCv.height = 16;
  const lctx = lightCv.getContext('2d', { willReadFrequently: true });

  /* ---------- outfit + colour pickers ---------- */
  rail.innerHTML = Object.entries(STYLES).map(([k, v]) => `<button type="button" data-style="${k}"><img src="${photoUrl(k, 124)}" alt="" loading="lazy">${v.label}</button>`).join('');
  colorsEl.innerHTML = Object.entries(COLORS).map(([k, v]) => `<button type="button" data-color="${k}" style="--c:${v.hex}" aria-label="${v.label}" title="${v.label}"></button>`).join('');
  rail.addEventListener('click', (e) => { const b = e.target.closest('[data-style]'); if (b) setLook(lookFor(b.dataset.style, look.size)); });
  colorsEl.addEventListener('click', (e) => { const b = e.target.closest('[data-color]'); if (b) setLook({ ...look, color: b.dataset.color }); });

  function setLook(next) {
    look = { ...next };
    nameEl.textContent = STYLES[look.style].label;
    rail.querySelectorAll('[data-style]').forEach((b) => b.classList.toggle('active', b.dataset.style === look.style));
    colorsEl.querySelectorAll('[data-color]').forEach((b) => b.classList.toggle('active', b.dataset.color === look.color));
    rail.querySelector('.active')?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }

  /* ---------- open / close ---------- */
  function open(startLook) {
    setLook(startLook ? { ...lookFor(startLook.style), ...startLook } : look);
    stage.classList.add('open'); document.body.classList.add('mirror-open');
    photoCard.hidden = true;
    startCard.hidden = !!stream;
    statusEl.textContent = 'Your phone will ask to use the camera. Tap Allow.';
    onStage && onStage(true);
  }
  function close() {
    stopCamera();
    stage.classList.remove('open'); document.body.classList.remove('mirror-open');
    onStage && onStage(false);
  }
  document.querySelectorAll('[data-open-mirror]').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); open(); }));
  $('#mrClose').addEventListener('click', close);
  $('#mrCancel').addEventListener('click', close);
  $('#mrGo').addEventListener('click', go);
  $('#mrShot').addEventListener('click', takePicture);
  $('#mrBack').addEventListener('click', () => { clearShot(); photoCard.hidden = true; });
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && stage.classList.contains('open')) close(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && stream) { stopCamera(); startCard.hidden = false; statusEl.textContent = 'The camera turned off because you left the page.'; } });
  addEventListener('pagehide', () => { if (stream) stopCamera(); });

  async function go() {
    if (!navigator.mediaDevices?.getUserMedia) { statusEl.textContent = 'The camera is not available here. Open this page in Chrome or Safari.'; return; }
    statusEl.textContent = 'Waiting for the camera…';
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    } catch (e) {
      stream = null;
      statusEl.textContent = e && e.name === 'NotAllowedError' ? 'Camera permission was declined. Allow the camera in your browser settings and try again.' : 'No camera found. Close other apps using the camera and try again.';
      return;
    }
    video.srcObject = stream;
    await video.play().catch(() => {});
    statusEl.textContent = 'Getting the mirror ready… a few seconds the first time.';
    try {
      [landmarker, G] = await Promise.all([getLandmarker({ masks: false }), import('./scene.js?v=15')]);
    } catch (e) {
      console.warn('Mirror could not load', e);
      statusEl.textContent = 'The mirror could not load. Check your internet connection and try again.';
      stopCamera();
      return;
    }
    if (!stream) return;
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { wakeLock = null; }
    startCard.hidden = true;
    sm = null; lastT = -1; frameNo = 0;
    loop();
  }

  function stopCamera() {
    cancelAnimationFrame(raf);
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    video.pause(); video.srcObject = null;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height);
    canvas.width = canvas.height = 0;
    lctx.clearRect(0, 0, 16, 16);
    wakeLock?.release?.().catch?.(() => {}); wakeLock = null;
    clearShot(); photoCard.hidden = true;
    setHint('');
  }
  function clearShot() { if (shotUrl) URL.revokeObjectURL(shotUrl); shotUrl = null; $('#mrPreview').removeAttribute('src'); $('#mrSave').removeAttribute('href'); }
  function setHint(t) { hintEl.textContent = t; hintEl.classList.toggle('show', !!t); }

  /* ---------- frame loop ---------- */
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
    if (frameNo % 30 === 1) sampleLight();
    const ok = lm && [11, 12, 23, 24].every((i) => lm[i].visibility > 0.5);
    if (ok) {
      lostFrames = 0;
      if (!sm) sm = lm.map((p) => ({ x: p.x, y: p.y }));
      else for (let i = 0; i < lm.length; i++) { sm[i].x = lerp(sm[i].x, lm[i].x, 0.5); sm[i].y = lerp(sm[i].y, lm[i].y, 0.5); }
    } else if (++lostFrames > 8) sm = null;
    setHint(sm ? '' : lostFrames > 20 || !lm ? 'Step back so the camera sees you from head to knees' : '');
    draw();
  }
  function sampleLight() {
    try {
      lctx.drawImage(video, 0, 0, 16, 16);
      const d = lctx.getImageData(0, 0, 16, 16).data;
      let s = 0; for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      lum = s / (d.length / 4);
    } catch { /* ignore */ }
  }

  /* ---------- drawing ---------- */
  function mapper() {
    const cw = canvas.clientWidth, ch = canvas.clientHeight, vw = video.videoWidth || 1, vh = video.videoHeight || 1;
    const s = Math.max(cw / vw, ch / vh), dw = vw * s, dh = vh * s, ox = (cw - dw) / 2, oy = (ch - dh) / 2;
    return { pt: (p) => [ox + p.x * dw, oy + p.y * dh], rect: [ox, oy, dw, dh] };
  }
  function ensureArt(hex) {
    const key = `${look.style}|${look.pattern}|${look.color}`;
    if (key === artKey) return;
    artKey = key;
    const p = STYLES[look.style];
    const g = art.getContext('2d');
    G.paintFabric(g, 512, 512, hex, look.pattern || 'plain', { circ: 2 * Math.PI * 0.3 * 0.87, len: G.topMax(p) - p.bottom });
    // a border-free piece of the cloth for sleeves
    const sg = swatch.getContext('2d');
    sg.drawImage(art, 150, 190, 128, 128, 0, 0, 128, 128);
    swatchPattern = ctx.createPattern(swatch, 'repeat');
  }

  function draw() {
    const dpr = Math.min(devicePixelRatio || 1, 2), cw = canvas.clientWidth, ch = canvas.clientHeight;
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) { canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr); }
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!sm || !G) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const M = mapper().pt;
    const P = (i) => M(sm[i]);
    const p = STYLES[look.style];
    const hex = COLORS[look.color].hex;
    ensureArt(hex);
    const time = performance.now() / 1000;

    // body frame from the tracked joints
    let L = P(11), R = P(12); if (L[0] > R[0]) [L, R] = [R, L];
    const S = mix(L, R, 0.5), Hp = mix(P(23), P(24), 0.5), K = mix(P(25), P(26), 0.5), A = mix(P(27), P(28), 0.5);
    const T = len(sub(Hp, S));
    const sw = Math.max(len(sub(R, L)), 0.55 * T);
    const ux = 1.55 * sw;            // pixels per catalogue unit across the body
    const u = norm(sub(R, L));
    let uh = [-(A[1] - Hp[1]), A[0] - Hp[0]]; uh = norm(uh); if (dot(uh, u) < 0) uh = [-uh[0], -uh[1]];
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

    // tapered tube along joints (sleeves, trouser legs)
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

    /* dupatta tails hang behind the shoulders */
    const dupHex = p.dupatta ? G.mixHex(hex, '#ffffff', G.lightness(hex) > 0.5 ? 0.12 : 0.25) : null;
    const dupW = 0.2 * sw;
    const ribbon = (pathFn) => {
      ctx.lineCap = 'butt'; ctx.lineJoin = 'round';
      ctx.globalAlpha = 0.8; ctx.strokeStyle = GOLD; ctx.lineWidth = dupW; pathFn(); ctx.stroke();
      ctx.strokeStyle = dupHex; ctx.lineWidth = dupW - 6; pathFn(); ctx.stroke();
      ctx.globalAlpha = 1;
    };
    if (p.dupatta) {
      for (const sgn of [-1, 1]) {
        const a = add(axis(0.9), u, sgn * half(0.88) * 0.86), b = add(axis(0.05), across(0.05), sgn * (half(0.05) + dupW * 0.25));
        ribbon(() => { ctx.beginPath(); ctx.moveTo(...a); ctx.quadraticCurveTo(...add(mix(a, b, 0.5), u, sgn * dupW * 0.5), ...b); });
      }
    }

    /* main garment: bodice + skirt (lehenga = two pieces with a bare midriff) */
    const ranges = p.midriff ? [[top, p.midriff[1]], [p.midriff[0], bot]] : [[top, bot]];
    const bodyPath = () => {
      ctx.beginPath();
      ranges.forEach(([y0, y1], ri) => {
        const N = 26, Lp = [], Rp = [];
        for (let i = 0; i <= N; i++) { const y = lerp(y0, y1, i / N); Lp.push(edge(y, -1)); Rp.push(edge(y, 1)); }
        ctx.moveTo(...Lp[0]);
        for (let i = 1; i <= N; i++) ctx.lineTo(...Lp[i]);
        // hem: a soft bow that sways a little
        const down = norm(sub(axis(y1), axis(y1 + 0.1)));
        const isHem = ri === ranges.length - 1;
        const bow = isHem ? 0.035 * T + Math.sin(time * 1.3) * 2 * (p.sway || 0) : 0.01 * T;
        ctx.quadraticCurveTo(...add(axis(y1), down, bow * 2), ...Rp[N]);
        for (let i = N - 1; i >= 0; i--) ctx.lineTo(...Rp[i]);
        // neckline (dips at the front) or a straight top edge
        const dip = ri === 0 ? (p.neck ? p.neck.dip : 0.012) : 0;
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
    // the cloth artwork wraps the whole body; show its front half
    ctx.drawImage(art, 384, 0, 128, 512, -maxHW, -0.02 * T, maxHW, L2);
    ctx.drawImage(art, 0, 0, 128, 512, 0, -0.02 * T, maxHW, L2);
    // roundness: darker at the sides, a soft highlight down the middle
    const g = ctx.createLinearGradient(-maxHW, 0, maxHW, 0);
    g.addColorStop(0, 'rgba(0,0,0,.36)'); g.addColorStop(0.2, 'rgba(0,0,0,.1)'); g.addColorStop(0.5, 'rgba(255,255,255,.08)');
    g.addColorStop(0.8, 'rgba(0,0,0,.1)'); g.addColorStop(1, 'rgba(0,0,0,.36)');
    ctx.fillStyle = g; ctx.fillRect(-maxHW, -0.05 * T, 2 * maxHW, L2 + 0.1 * T);
    // folds fanning from the waist to the hem
    const wy = p.waist ?? 0.515;
    if (bot < wy - 0.25) {
      const yl = (y) => dot(sub(axis(y), Ct), norm(d));
      const y0 = yl(wy), y1 = L2, hw0 = half(wy), hw1 = half(bot);
      const n = clamp(Math.round((p.pleats || 8) * 0.5), 5, 16);
      // folds fade in below the waist so they do not read as a seam
      const fade = (rgb, a) => { const fg = ctx.createLinearGradient(0, y0, 0, y1); fg.addColorStop(0, `rgba(${rgb},0)`); fg.addColorStop(0.35, `rgba(${rgb},${a})`); fg.addColorStop(1, `rgba(${rgb},${a})`); return fg; };
      const foldDark = fade('0,0,0', 0.14), foldLight = fade('255,255,255', 0.08);
      for (let i = 0; i < n; i++) {
        const f = ((i + 0.5) / n) * 2 - 1, wob = Math.sin(time * 1.1 + i * 1.7) * 2.5 * (p.sway || 0);
        ctx.beginPath(); ctx.moveTo(f * hw0 * 0.85, y0); ctx.quadraticCurveTo(f * lerp(hw0, hw1, 0.5) + wob, lerp(y0, y1, 0.55), f * hw1 + wob, y1);
        ctx.strokeStyle = foldDark; ctx.lineWidth = Math.max(2, sw * 0.014); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(f * hw0 * 0.85 + 3, y0); ctx.quadraticCurveTo(f * lerp(hw0, hw1, 0.5) + wob + 4, lerp(y0, y1, 0.55), f * hw1 + wob + 5, y1);
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

    /* dupatta across the chest */
    if (p.dupatta) {
      const a = add(axis(0.9), u, -half(0.88) * 0.86), b = add(axis(0.9), u, half(0.88) * 0.86), c = axis(0.36);
      ribbon(() => { ctx.beginPath(); ctx.moveTo(...a); ctx.bezierCurveTo(...mix(a, c, 0.75), ...mix(b, c, 0.75), ...b); });
    }
  }

  /* ---------- take a picture (kept on the device) ---------- */
  function takePicture() {
    if (!stream || !canvas.width) return;
    const out = document.createElement('canvas'); out.width = canvas.width; out.height = canvas.height;
    const o = out.getContext('2d');
    const dpr = canvas.width / canvas.clientWidth;
    const [ox, oy, dw, dh] = mapper().rect;
    o.save(); o.translate(out.width, 0); o.scale(-1, 1);
    o.drawImage(video, ox * dpr, oy * dpr, dw * dpr, dh * dpr);
    o.drawImage(canvas, 0, 0);
    o.restore();
    o.font = `600 ${Math.round(15 * dpr)}px "Inter Tight", system-ui, sans-serif`;
    o.fillStyle = 'rgba(255,255,255,.85)'; o.shadowColor = 'rgba(0,0,0,.6)'; o.shadowBlur = 6;
    o.fillText(`MIRAAL · ${STYLES[look.style].label}`, 16 * dpr, out.height - 18 * dpr);
    out.toBlob((blob) => {
      if (!blob) { toast('Could not take the picture'); return; }
      clearShot();
      shotUrl = URL.createObjectURL(blob);
      $('#mrPreview').src = shotUrl; $('#mrSave').href = shotUrl;
      photoCard.hidden = false;
    }, 'image/jpeg', 0.9);
  }

  setLook(look);
  return { open };
}
