// Pure per-frame body measurement from MediaPipe pose landmarks + the person mask.
// No camera, DOM or state in here, so it can be tested on recorded frames.
//
// Background protection (things behind you getting mixed into your outline):
// - Head top and feet are found by walking the mask *continuously* from your face and
//   ankles, so a lamp, shelf or picture above you can no longer change your height scale.
// - Every width/depth is measured inside a corridor built from your own skeleton. If the
//   outline runs into the corridor edge (a sofa, door frame, curtain or person touching you)
//   that row is rejected instead of being measured too wide.
// - Mask pixels far away from your skeleton are counted; a busy background is reported so
//   the user can be asked to move, and those frames are not used.
// - A final proportion check rejects frames whose scale is clearly wrong.

export const PRIOR = { shoulder: 0.238, bust: 0.514, waist: 0.406, hips: 0.56, inseam: 0.452, arm: 0.343, neck: 0.205, thigh: 0.322 };
export const DEPTH_RATIO = { neck: 0.95, bust: 0.72, waist: 0.76, hips: 0.8, thigh: 1.0 };
export const CIRC_FACTOR = { neck: 1.0, bust: 1.05, waist: 1.0, hips: 1.0, thigh: 1.0 };
export const ROW_KEYS = ['neck', 'bust', 'waist', 'hips', 'thigh'];

const ON = 0.5;
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const avg = (...v) => { const x = v.filter((n) => n != null && isFinite(n)); return x.length ? x.reduce((s, n) => s + n, 0) / x.length : null; };
export const ellipse = (w, d) => { const a = w / 2, b = d / 2; return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b))); };

/**
 * @param lm    33 pose landmarks (normalised 0..1, with visibility)
 * @param mask  Float32Array person mask, mw*mh, values 0..1
 * @param o     { mw, mh, vw, vh, height } video size in px and the user's height in cm
 */
export function measureFrame(lm, mask, o) {
  const { mw, mh, vw, vh, height: H } = o;
  const f = { runs: {}, cm: null, checks: {}, bleed: [], orient: 'turning', dir: 1 };
  const at = (x, y) => mask[y * mw + x];
  const vis = (i) => lm[i] && lm[i].visibility > 0.5;
  const sx = (lm[11].x + lm[12].x) / 2, sy = (lm[11].y + lm[12].y) / 2;
  const hx = (lm[23].x + lm[24].x) / 2, hy = (lm[23].y + lm[24].y) / 2;
  const T = Math.max(0.02, hy - sy); // torso length, y-normalised
  const Tx = T * vh / vw;            // torso length expressed in x-normalised units
  const swN = Math.abs(lm[11].x - lm[12].x);
  const ratio = (swN * vw) / (T * vh);
  const faceVis = Math.max(lm[0].visibility, lm[2].visibility, lm[5].visibility);
  f.orient = ratio < 0.42 ? 'side' : ratio > 0.58 ? (lm[11].x > lm[12].x && faceVis > 0.5 ? 'front' : 'back') : 'turning';
  f.dir = lm[0].x > hx ? 1 : -1;
  const isSide = f.orient === 'side';

  /* ---- vertical extent: walk the mask continuously from the face up and from the ankles down ---- */
  const noseY = lm[0].y;
  const headSpan = Math.max(0.02, sy - noseY);
  const headLimit = noseY - 1.15 * headSpan;          // nobody's crown is this far above the nose
  const footIds = [27, 28, 29, 30, 31, 32].filter(vis);
  const footY = footIds.length ? Math.max(...footIds.map((i) => lm[i].y)) : null;
  const footLimit = footY == null ? 1 : footY + 0.12 * T;

  const rowHas = (y, x0, x1) => { for (let x = x0; x <= x1; x++) if (at(x, y) >= ON) return true; return false; };
  const px = (nx) => clamp(Math.round(nx * (mw - 1)), 0, mw - 1);
  const py = (ny) => clamp(Math.round(ny * (mh - 1)), 0, mh - 1);

  // head: start between nose and shoulders, walk up while the head column still has body pixels
  const headX = isSide ? lerp(lm[0].x, avg(vis(7) ? lm[7].x : null, vis(8) ? lm[8].x : null) ?? lm[0].x, 0.6) : lm[0].x;
  const hb = Math.max(0.012, 0.2 * (isSide ? Tx : Math.max(swN, 0.5 * Tx)));
  let y = py((noseY + sy) / 2), top = null;
  const yStop = py(Math.max(0, headLimit));
  const hx0 = px(headX - hb), hx1 = px(headX + hb);
  if (rowHas(y, hx0, hx1)) {
    while (y > 0 && y > yStop && rowHas(y - 1, hx0, hx1)) y--;
    top = y / mh;
    if (y <= yStop && y > 0 && rowHas(y - 1, hx0, hx1)) f.bleed.push('head');
  }

  // feet: walk down from each visible ankle while the foot column has body pixels
  let bottom = null;
  const yFootStop = py(Math.min(1, footLimit));
  for (const a of [27, 28]) {
    if (!vis(a)) continue;
    const fx0 = px(lm[a].x - 0.15 * Tx), fx1 = px(lm[a].x + 0.15 * Tx);
    let yy = py(lm[a].y);
    if (!rowHas(yy, fx0, fx1)) continue;
    while (yy < mh - 1 && yy < yFootStop && rowHas(yy + 1, fx0, fx1)) yy++;
    if (yy >= yFootStop && yy < mh - 1 && rowHas(yy + 1, fx0, fx1)) { f.bleed.push('floor'); yy = py(footY + 0.03 * T); }
    bottom = Math.max(bottom ?? 0, (yy + 1) / mh);
  }
  f.ext = top != null && bottom != null ? { top, bottom } : null;
  const ext = f.ext;
  const frac = ext ? ext.bottom - ext.top : 0;
  f.frac = frac;

  /* ---- checks ---- */
  f.checks.body = !!ext && ext.top > 0.012 && ext.bottom < 0.988 && (vis(27) || vis(28)) && (vis(11) || vis(12));
  f.checks.distance = frac >= 0.5 && frac <= 0.93;
  f.bodyHint = !ext && !(vis(27) || vis(28)) ? 'Step back so your feet are in view'
    : !ext ? 'Step into the frame'
    : ext.top <= 0.012 ? 'Your head is cut off — step back or tilt the phone up'
    : ext.bottom >= 0.988 || !(vis(27) || vis(28)) ? 'Your feet are cut off — step back a little' : '';
  f.distHint = frac > 0.93 ? 'Step back a little' : frac < 0.5 ? 'Come a bit closer' : '';

  const wristOut = (w, h) => Math.abs(lm[w].x - lm[h].x) > 0.28 * swN && lm[w].y > sy;
  f.checks.arms = wristOut(15, 23) && wristOut(16, 24);

  // upright: shoulders should be straight above the ankles (phone not rolled sideways)
  const ankX = avg(vis(27) ? lm[27].x : null, vis(28) ? lm[28].x : null);
  const ankY = avg(vis(27) ? lm[27].y : null, vis(28) ? lm[28].y : null);
  f.lean = ankX == null ? 0 : Math.atan2((sx - ankX) * vw, (ankY - sy) * vh) * 180 / Math.PI;
  f.checks.upright = Math.abs(f.lean) < 8;

  // background: body pixels far away from the skeleton = furniture / curtains / other people
  const xs = [], ys = [];
  for (let i = 0; i < 33; i++) if (vis(i)) { xs.push(lm[i].x); ys.push(lm[i].y); }
  const mx = 0.45 * Math.max(swN, 0.45 * Tx);
  const bx0 = Math.min(...xs) - mx, bx1 = Math.max(...xs) + mx;
  const by0 = headLimit, by1 = footLimit;
  let inside = 0, outside = 0;
  for (let yy = 0; yy < mh; yy += 4) {
    const yn = yy / mh, o2 = yy * mw;
    for (let xx = 0; xx < mw; xx += 4) {
      if (mask[o2 + xx] < ON) continue;
      const xn = xx / mw;
      if (xn < bx0 || xn > bx1 || yn < by0 || yn > by1) outside++; else inside++;
    }
  }
  f.clutter = inside ? outside / inside : 0;
  f.checks.background = f.clutter < 0.06 && !f.bleed.includes('head');
  f.bgHint = f.bleed.includes('head') ? 'Move away from things behind your head (shelf, lamp, door frame)'
    : f.clutter >= 0.06 ? 'Things behind you are getting mixed in — stand in front of a plain wall' : '';

  if (!ext || !(H >= 130 && H <= 215)) return f;

  /* ---- widths / depths inside a skeleton corridor ---- */
  const cmPx = H / (frac * vh);
  const mouthY = (lm[9].y + lm[10].y) / 2;
  const kneeY = (lm[25].y + lm[26].y) / 2;
  const earX = avg(vis(7) ? lm[7].x : null, vis(8) ? lm[8].x : null) ?? sx;
  const unit = isSide ? Tx : swN;
  const HALF = isSide ? { neck: 0.3, bust: 0.62, waist: 0.62, hips: 0.62, thigh: 0.45 }
    : { neck: 0.42, bust: 0.78, waist: 0.78, hips: 0.88, thigh: 0.44 };
  const rows = {
    neck: [mouthY + 0.4 * (sy - mouthY), isSide ? lerp(earX, sx, 0.6) : sx],
    bust: [sy + 0.3 * T, lerp(sx, hx, 0.3)],
    waist: [sy + 0.64 * T, lerp(sx, hx, 0.64)],
    hips: [hy + 0.06 * T, hx],
    thigh: [hy + 0.3 * (kneeY - hy), isSide ? hx : lerp(lm[23].x, lm[25].x, 0.3)],
  };
  const cm = {};
  for (const k of ROW_KEYS) {
    const r = run(mask, mw, mh, rows[k][0], rows[k][1], HALF[k] * unit);
    if (!r) continue;
    f.runs[k] = r;
    if (r.bled) { f.bleed.push(k); continue; }
    cm[k] = r.w * vw * cmPx;
  }
  // what ran into the corridor because of the background (not arms, legs or hair)
  let armsMerged = false;
  if (!isSide) {
    // arms touching the torso make the chest/waist silhouette too wide
    armsMerged = (f.runs.bust && f.runs.bust.w > 1.25 * swN) || (f.bleed.includes('bust') && !f.checks.arms);
    if (armsMerged) { f.checks.arms = false; delete cm.bust; delete cm.waist; }
    // legs touching: the thigh run spans both legs
    if ((cm.thigh && cm.hips && cm.thigh > 0.62 * cm.hips) || f.bleed.includes('thigh')) { delete cm.thigh; f.legsTogether = true; }
  }
  // front/back: with the arms hanging down, hands touch the chest/waist/hips — that is the arms, not the room
  const armsAway = f.checks.arms && !armsMerged;
  f.bgBleed = f.bleed.filter((k) => k === 'head'
    || (!isSide && armsAway && (k === 'bust' || k === 'waist' || k === 'hips'))
    || (isSide && (k === 'bust' || k === 'waist' || k === 'hips')));
  if (!isSide && !armsAway && f.bleed.some((k) => k === 'bust' || k === 'waist' || k === 'hips')) f.checks.arms = false;
  if (f.bgBleed.length) f.checks.background = false;
  f.bgHint = f.bgBleed.includes('head') ? 'Move away from things behind your head (shelf, lamp, door frame)'
    : f.bgBleed.length ? 'Step away from furniture — something behind you is touching your outline'
    : f.clutter >= 0.06 ? 'Things behind you are getting mixed in — stand in front of a plain wall' : '';
  if (!isSide) {
    const d = (a, b) => Math.hypot((lm[a].x - lm[b].x) * vw, (lm[a].y - lm[b].y) * vh);
    cm.shoulder = swN * vw * cmPx * 1.18;
    cm.arm = ((d(11, 13) + d(13, 15) + d(12, 14) + d(14, 16)) / 2) * cmPx * 1.05;
    const ankleY = (lm[27].y + lm[28].y) / 2;
    let cy = crotchY(mask, mw, mh, hx, ext.bottom, hy);
    if (cy == null || cy > hy + 0.35 * (ankleY - hy)) cy = hy + 0.1 * (ankleY - hy);
    cm.inseam = (ext.bottom - cy) * vh * cmPx;
    // proportion guard: if shoulders come out wildly off for this height, the scale is wrong
    const sr = cm.shoulder / (H * PRIOR.shoulder);
    if (sr < 0.68 || sr > 1.45) {
      f.scaleBad = true; f.checks.background = false;
      f.bgHint = f.bgHint || 'Make sure nothing behind you touches your head or feet';
      return f;
    }
  }
  f.cm = cm;
  return f;
}

// Horizontal run of body pixels through (cx, y), confined to cx ± half.
// bled = the outline kept going past the corridor edge, i.e. something is touching the body.
export function run(mask, mw, mh, yN, cxN, half) {
  if (!(yN > 0 && yN < 1)) return null;
  const yc = Math.round(yN * (mh - 1));
  const lo = Math.max(0, Math.round((cxN - half) * (mw - 1)));
  const hi = Math.min(mw - 1, Math.round((cxN + half) * (mw - 1)));
  let sum = 0, L = 0, R = 0, n = 0, bled = 0;
  for (let dy = -2; dy <= 2; dy++) {
    const y = yc + dy; if (y < 0 || y >= mh) continue;
    const o = y * mw;
    let c = Math.round(clamp(cxN, 0, 1) * (mw - 1));
    if (mask[o + c] < ON) {
      let f = -1; const lim = Math.round(mw * 0.03);
      for (let d = 1; d <= lim; d++) {
        if (c + d <= hi && mask[o + c + d] >= ON) { f = c + d; break; }
        if (c - d >= lo && mask[o + c - d] >= ON) { f = c - d; break; }
      }
      if (f < 0) continue; c = f;
    }
    let l = c, r = c;
    while (l > lo && mask[o + l - 1] >= ON) l--;
    while (r < hi && mask[o + r + 1] >= ON) r++;
    if ((l === lo && lo > 0 && mask[o + lo - 1] >= ON) || (r === hi && hi < mw - 1 && mask[o + hi + 1] >= ON)) bled++;
    sum += r - l + 1; L += l; R += r + 1; n++;
  }
  return n ? { w: sum / n / mw, l: L / n / mw, r: R / n / mw, y: yN, bled: bled >= 2 } : null;
}

export function crotchY(mask, mw, mh, cxN, bottomN, hipN) {
  const c = Math.round(cxN * (mw - 1));
  let y = Math.min(mh - 1, Math.round(bottomN * mh) - 3);
  if (mask[y * mw + c] >= ON) return null; // legs together: no gap to find
  const stop = Math.round(hipN * mh);
  while (y > stop && mask[y * mw + c] < ON) y--;
  return y <= stop ? null : y / mh;
}

/** Combine captured front/back widths and side depths into circumferences. */
export function combine({ height: H, front = {}, back = {}, side1 = {}, side2 = {}, liveW = {}, liveD = {}, liveLen = {}, final }) {
  const clampP = (k, v) => (v == null ? null : Math.min(H * PRIOR[k] * 1.3, Math.max(H * PRIOR[k] * 0.7, v)));
  const out = { height: H };
  const state = { height: 'ok' };
  for (const k of ROW_KEYS) {
    const w = avg(front[k], back[k]) ?? (final ? null : liveW[k]);
    const dCap = avg(side1[k], side2[k]);
    const d = dCap ?? (final ? null : liveD[k]) ?? (w ? w * DEPTH_RATIO[k] : null);
    out[k] = w ? clampP(k, ellipse(w, d) * CIRC_FACTOR[k]) : (final ? H * PRIOR[k] : null);
    state[k] = (front[k] || back[k]) && dCap ? 'ok' : w ? 'est' : '';
  }
  for (const k of ['shoulder', 'arm', 'inseam']) {
    const v = front[k] ?? back[k] ?? (final ? null : liveLen[k]);
    out[k] = v ? clampP(k, v) : (final ? H * PRIOR[k] : null);
    state[k] = front[k] || back[k] ? 'ok' : v ? 'est' : '';
  }
  return { out, state };
}
