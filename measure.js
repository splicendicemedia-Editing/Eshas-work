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
//
// Arms: people stand relaxed, so an arm often rests against the body. In the front and back views
// each arm's inner edge is worked out from the skeleton and the body is measured up to that edge,
// so nobody has to hold their arms out. Only hands in front of the body (crossed arms, hands in
// pockets) still hide the body's edge.

export const PRIOR = { shoulder: 0.238, bust: 0.514, waist: 0.406, hips: 0.56, inseam: 0.452, arm: 0.343, neck: 0.205, thigh: 0.322 };
export const DEPTH_RATIO = { neck: 0.95, bust: 0.72, waist: 0.76, hips: 0.8, thigh: 1.0 };
export const CIRC_FACTOR = { neck: 1.0, bust: 1.05, waist: 1.0, hips: 1.0, thigh: 1.0 };
export const ROW_KEYS = ['neck', 'bust', 'waist', 'hips', 'thigh'];
// highest believable value, as a multiple of the usual value for the person's height
export const CAP = { neck: 1.3, bust: 1.7, waist: 1.7, hips: 1.7, thigh: 1.5, shoulder: 1.3, arm: 1.3, inseam: 1.3 };

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

  f.checks.arms = true; // set to false further down if a hand or arm is in front of the body

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
  // size reference for the turn-around step: hip-to-ankle length does not change as the person turns
  if (ankY != null && ankY - hy > 0.05) f.scale = { cmPx, leg: (ankY - hy) * vh, torso: T / (ankY - hy) };
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
  // where each arm is at height y: [arm on the left, arm on the right] of the body, or null
  // arm thickness is taken as a share of shoulder width: upper arm, elbow, wrist, hand
  const armLimits = (y, cx) => {
    let L = null, R = null;
    if (isSide) return [L, R];
    for (const [s, e, w] of [[11, 13, 15], [12, 14, 16]]) {
      if (!vis(s) || !vis(e)) continue;
      const chain = [[lm[s], 0.145], [lm[e], 0.115]];
      if (vis(w)) {
        chain.push([lm[w], 0.09]);
        chain.push([{ x: lm[w].x + (lm[w].x - lm[e].x) * 0.35, y: lm[w].y + (lm[w].y - lm[e].y) * 0.35 }, 0.11]);
      }
      for (let i = 0; i < chain.length - 1; i++) {
        const [a, ra] = chain[i], [b, rb] = chain[i + 1];
        if (Math.abs(b.y - a.y) < 1e-4 || y < Math.min(a.y, b.y) || y > Math.max(a.y, b.y)) continue;
        const t = (y - a.y) / (b.y - a.y), ax = lerp(a.x, b.x, t), rad = lerp(ra, rb, t) * swN;
        // the arm's centre line, its usual thickness, and the least and most it can be
        // an arm that hangs is close to upright; one that slants across (hand in a pocket, hand on the hip)
        // lies over the body, so the body's edge cannot be read there
        let slant = Math.abs((b.x - a.x) * vw) / Math.max(1, Math.abs((b.y - a.y) * vh)) > 0.4;
        // a hanging arm moves outwards from the body's side line (shoulder joint to hip joint) on the way
        // down: level with it at the shoulder, about a third of a shoulder width outside it at the hips.
        // An arm well inside that (hand in a pocket, hand on the stomach) is over the body.
        const hipJ = lm[s === 11 ? 23 : 24];
        const down = (y - lm[s].y) / Math.max(1e-4, hipJ.y - lm[s].y);
        const outside = (ax - lerp(lm[s].x, hipJ.x, down)) * Math.sign(lm[s].x - sx || 1);
        if (outside < (0.33 * down - 0.2) * swN) slant = true;
        const arm = { x: ax, r: rad, min: 0.08 * swN, max: 0.2 * swN, slant };
        if (ax < cx) { if (!L || ax > L.x) L = arm; } else if (!R || ax < R.x) R = arm;
        break;
      }
    }
    return [L, R];
  };
  const cm = {};
  for (const k of ROW_KEYS) {
    const [aL, aR] = k === 'neck' || k === 'thigh' ? [null, null] : armLimits(rows[k][0], rows[k][1]);
    const r = run(mask, mw, mh, rows[k][0], rows[k][1], HALF[k] * unit, aL, aR);
    if (!r) continue;
    f.runs[k] = r;
    if (r.bled) { f.bleed.push(k); continue; }
    cm[k] = r.w * vw * cmPx;
  }
  if (!isSide) {
    // a hand or arm in front of the body hides the body's edge: the cut leaves too little body
    const least = { bust: 0.62, waist: 0.5, hips: 0.62 };
    f.armsInFront = ['bust', 'waist', 'hips'].some((k) => f.runs[k] && (f.runs[k].over || (f.runs[k].cut && f.runs[k].w < least[k] * swN)));
    if (f.armsInFront) { f.checks.arms = false; delete cm.bust; delete cm.waist; delete cm.hips; }
    // legs touching: the thigh run spans both legs
    if ((cm.thigh && cm.hips && cm.thigh > 0.62 * cm.hips) || f.bleed.includes('thigh')) { delete cm.thigh; f.legsTogether = true; }
  }
  // the outline running past its limit where no arm explains it = furniture, a curtain, another person
  f.bgBleed = f.bleed.filter((k) => k === 'head' || k === 'bust' || k === 'waist' || k === 'hips');
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
// clipL / clipR (optional) = an arm beside the body { x: centre line, r: usual radius, min, max }.
// When the outline runs on into that arm, the arm's real thickness is read from its outer edge
// (centre to outer edge = centre to inner edge) and the body is measured only up to its inner edge.
export function run(mask, mw, mh, yN, cxN, half, clipL = null, clipR = null) {
  if (!(yN > 0 && yN < 1)) return null;
  const yc = Math.round(yN * (mh - 1));
  const lo = Math.max(0, Math.round((cxN - half) * (mw - 1)));
  const hi = Math.min(mw - 1, Math.round((cxN + half) * (mw - 1)));
  let sum = 0, L = 0, R = 0, n = 0, bled = 0, cut = 0, over = 0;
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
    const outL = l === lo && lo > 0 && mask[o + lo - 1] >= ON, outR = r === hi && hi < mw - 1 && mask[o + hi + 1] >= ON;
    let cutL = false, cutR = false;
    const px = (v) => v * (mw - 1);
    if ((clipL && clipL.slant && l < px(clipL.x)) || (clipR && clipR.slant && r > px(clipR.x))) over++;
    if (clipL && l < px(clipL.x)) {
      const rad = outL ? clipL.r : Math.min(clipL.max, Math.max(clipL.min, clipL.x - l / (mw - 1)));
      l = Math.min(Math.round(px(clipL.x + rad)), c); cutL = true;
    }
    if (clipR && r > px(clipR.x)) {
      const rad = outR ? clipR.r : Math.min(clipR.max, Math.max(clipR.min, r / (mw - 1) - clipR.x));
      r = Math.max(Math.round(px(clipR.x - rad)), c); cutR = true;
    }
    if ((outL && !cutL) || (outR && !cutR)) bled++;
    if (cutL || cutR) cut++;
    sum += r - l + 1; L += l; R += r + 1; n++;
  }
  return n ? { w: sum / n / mw, l: L / n / mw, r: R / n / mw, y: yN, bled: bled >= 2, cut: cut >= 2, over: over >= 2 } : null;
}

export function crotchY(mask, mw, mh, cxN, bottomN, hipN) {
  const c = Math.round(cxN * (mw - 1));
  let y = Math.min(mh - 1, Math.round(bottomN * mh) - 3);
  if (mask[y * mw + c] >= ON) return null; // legs together: no gap to find
  const stop = Math.round(hipN * mh);
  while (y > stop && mask[y * mw + c] < ON) y--;
  return y <= stop ? null : y / mh;
}

/** Combine captured front/back widths and side depths into circumferences. around = measured all the way round in the turn. */
export function combine({ height: H, front = {}, back = {}, side1 = {}, side2 = {}, around = {}, liveW = {}, liveD = {}, liveLen = {}, final }) {
  // Sanity limits around what is usual for this height. Chest, waist and hips vary a lot between
  // people of the same height, so their upper limit is wide; lengths vary much less.
  const capped = [];
  const clampP = (k, v) => {
    if (v == null) return null;
    const lo = H * PRIOR[k] * 0.7, hi = H * PRIOR[k] * (CAP[k] || 1.3);
    if (v < lo || v > hi) capped.push(k);
    return Math.min(hi, Math.max(lo, v));
  };
  const out = { height: H };
  const state = { height: 'ok' };
  for (const k of ROW_KEYS) {
    if (around[k]) { out[k] = clampP(k, around[k]); state[k] = capped.includes(k) ? 'est' : 'ok'; continue; }
    const w = avg(front[k], back[k]) ?? (final ? null : liveW[k]);
    const dCap = avg(side1[k], side2[k]);
    const d = dCap ?? (final ? null : liveD[k]) ?? (w ? w * DEPTH_RATIO[k] : null);
    out[k] = w ? clampP(k, ellipse(w, d) * CIRC_FACTOR[k]) : (final ? H * PRIOR[k] : null);
    state[k] = capped.includes(k) ? 'est' : (front[k] || back[k]) && dCap ? 'ok' : w ? 'est' : '';
  }
  for (const k of ['shoulder', 'arm', 'inseam']) {
    const v = front[k] ?? back[k] ?? (final ? null : liveLen[k]);
    out[k] = v ? clampP(k, v) : (final ? H * PRIOR[k] : null);
    state[k] = capped.includes(k) ? 'est' : front[k] || back[k] ? 'ok' : v ? 'est' : '';
  }
  return { out, state, capped };
}

/* ---------- turn-around step ---------- */
// While the person turns all the way round, every frame gives the body's width at chest, waist and
// hips as seen from that angle. For any outline without dents, the distance round it (what a tape
// measures) is exactly pi times the average width over all viewing angles (Cauchy's formula). So
// with the arms out of the way (hands on the head) the turn measures the real distance round the
// body instead of assuming it is an oval. With the arms hanging, the angled views include the arms,
// so only the true side views are used, for depth.

/** One frame of the turn: widths in pixels, how side-on the person is, and the size reference. */
export function turnWidths(lm, mask, o) {
  const { mw, mh, vw, vh, torso } = o;
  const vis = (i) => lm[i] && lm[i].visibility > 0.5;
  if (!(vis(11) && vis(12)) || !(vis(23) || vis(24))) return null;
  const sx = (lm[11].x + lm[12].x) / 2, sy = (lm[11].y + lm[12].y) / 2;
  const hx = (lm[23].x + lm[24].x) / 2, hy = (lm[23].y + lm[24].y) / 2;
  const ank = avg(vis(27) ? lm[27].y : null, vis(28) ? lm[28].y : null);
  if (ank == null || ank - hy < 0.05) return null;
  const leg = (ank - hy) * vh;                       // hip to ankle in pixels: does not change as the person turns or lifts their arms
  // chest and waist levels are counted up from the hips with the torso length seen in the front
  // view, because lifting the arms moves the shoulders
  const T = torso ? torso * (ank - hy) : Math.max(0.02, hy - sy);
  const Tx = T * vh / vw;
  const top = hy - T;
  const rows = { bust: [top + 0.3 * T, lerp(sx, hx, 0.3)], waist: [top + 0.64 * T, lerp(sx, hx, 0.64)], hips: [hy + 0.06 * T, hx] };
  const px = {};
  for (const k of Object.keys(rows)) {
    const r = run(mask, mw, mh, rows[k][0], rows[k][1], 0.66 * Tx);
    if (r && !r.bled) px[k] = r.w * vw;
  }
  const faceVis = Math.max(lm[0].visibility, lm[2].visibility, lm[5].visibility);
  return {
    ratio: (Math.abs(lm[11].x - lm[12].x) * vw) / leg,  // widest facing or back to the camera, smallest side-on
    facing: lm[11].x > lm[12].x && faceVis > 0.5 ? 'front' : 'back',
    armsUp: vis(15) && vis(16) && lm[15].y < sy && lm[16].y < sy,
    leg, px,
  };
}

/**
 * Turn the frames of one turn into measurements.
 * scale = { cmPx, leg } from the front view. Returns
 *   mode 'around' -> around[k] = distance round the body in cm (arms were up, enough angles seen)
 *   mode 'side'   -> depth[k]  = front-to-back depth in cm from the side views
 *   mode 'none'   -> not enough to use
 */
export function fromTurn(samples, scale) {
  const out = { mode: 'none', around: {}, depth: {}, armsUp: false, angles: 0, frames: samples.length };
  if (!scale || !scale.cmPx || samples.length < 12) return out;
  const rs = samples.map((s) => s.ratio).sort((a, b) => a - b);
  const q = (p) => rs[Math.min(rs.length - 1, Math.floor(p * rs.length))];
  const rMax = q(0.95), rMin = Math.min(q(0.05), 0.3 * rMax);
  // 0 = facing or back to the camera, 90 = side-on
  const yaw = (s) => Math.acos(clamp((s.ratio - rMin) / Math.max(1e-6, rMax - rMin), 0, 1)) * 180 / Math.PI;
  const NB = 9; // 10-degree steps
  out.armsUp = samples.filter((s) => s.armsUp).length / samples.length >= 0.7;
  let fewest = NB;
  for (const k of ['bust', 'waist', 'hips']) {
    const sum = new Array(NB).fill(0), cnt = new Array(NB).fill(0);
    for (const s of samples) {
      if (s.px[k] == null || !s.leg) continue;
      const b = Math.min(NB - 1, Math.floor(yaw(s) / (90 / NB)));
      sum[b] += s.px[k] * scale.cmPx * (scale.leg / s.leg); // same size reference as the front view, even if they stepped nearer
      cnt[b]++;
    }
    const m = cnt.map((c, i) => (c ? sum[i] / c : null));
    const filled = m.filter((v) => v != null).length;
    fewest = Math.min(fewest, filled);
    const side = m[8] ?? m[7];
    if (side != null) out.depth[k] = side;
    if (out.armsUp && filled >= 7 && (m[0] ?? m[1]) != null && side != null) {
      // fill a missing step from its neighbours
      for (let i = 0; i < NB; i++) {
        if (m[i] != null) continue;
        let a = i - 1, b = i + 1;
        while (a >= 0 && m[a] == null) a--;
        while (b < NB && m[b] == null) b++;
        m[i] = a < 0 ? m[b] : b >= NB ? m[a] : lerp(m[a], m[b], (i - a) / (b - a));
      }
      out.around[k] = Math.PI * m.reduce((x, y) => x + y, 0) / NB;
    }
  }
  out.angles = fewest;
  out.mode = Object.keys(out.around).length === 3 ? 'around' : Object.keys(out.depth).length ? 'side' : 'none';
  if (out.mode !== 'around') out.around = {};
  return out;
}
