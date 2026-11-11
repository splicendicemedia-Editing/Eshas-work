import { STYLES, FABRICS, COLORS, SIZES } from './catalog.js';
import { initCamera } from './camera.js';
import { initProfile } from './profile.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* ---------------- loader ---------------- */
let loaderHidden = false;
function hideLoader() {
  if (loaderHidden) return;
  loaderHidden = true;
  document.body.classList.add('loaded');
  // kick hero reveals once the curtain lifts
  setTimeout(() => $$('.hero .reveal').forEach((el) => el.classList.add('in')), 150);
}
setTimeout(hideLoader, 7000);

/* ---------------- nav ---------------- */
const nav = $('.nav');
const onScroll = () => nav.classList.toggle('scrolled', scrollY > 20);
addEventListener('scroll', onScroll, { passive: true });
onScroll();

/* ---------------- reveals ---------------- */
const rio = new IntersectionObserver((es) => es.forEach((e) => {
  if (e.isIntersecting && !e.target.closest('.hero')) { e.target.classList.add('in'); rio.unobserve(e.target); }
}), { threshold: 0.15 });
$$('.reveal').forEach((el) => rio.observe(el));

// spotlight on feature cards
$$('.card').forEach((c) => c.addEventListener('pointermove', (e) => {
  const r = c.getBoundingClientRect();
  c.style.setProperty('--mx', `${e.clientX - r.left}px`);
  c.style.setProperty('--my', `${e.clientY - r.top}px`);
}));

/* ---------------- toast ---------------- */
let toastT;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('show'), 2600);
}

/* ---------------- 3D scene ---------------- */
const studioLook = { style: 'slip', fabric: 'silk', color: 'champagne', size: 'M' };
let scene = null;

import('./scene.js')
  .then(({ createScene }) => {
    scene = createScene({ canvas: $('#scene'), labelsEl: $('#labels'), onReady: hideLoader, studioLook: { ...studioLook } });
    observeStates();
  })
  .catch((err) => {
    console.error('3D scene unavailable:', err);
    document.body.classList.add('no-webgl');
    hideLoader();
  });

function observeStates() {
  const els = $$('[data-state]');
  const center = new IntersectionObserver((es) => {
    es.forEach((e) => { if (e.isIntersecting) scene.setState(e.target.dataset.state); });
  }, { rootMargin: '-48% 0px -48% 0px' });
  els.forEach((el) => center.observe(el));

  const visible = new Set();
  const any = new IntersectionObserver((es) => {
    es.forEach((e) => (e.isIntersecting ? visible.add(e.target) : visible.delete(e.target)));
    scene.setActive(visible.size > 0);
  });
  els.forEach((el) => any.observe(el));
}

/* ---------------- studio controls ---------------- */
function buildStudio() {
  $('[data-group="style"]').innerHTML = Object.entries(STYLES).map(([k, v]) => `<button class="chip" type="button" data-v="${k}">${v.label}</button>`).join('');
  $('[data-group="fabric"]').innerHTML = Object.entries(FABRICS).map(([k, v]) => `<button class="chip" type="button" data-v="${k}">${v.label}</button>`).join('');
  $('[data-group="color"]').innerHTML = Object.entries(COLORS).map(([k, v]) => `<button class="swatch" type="button" data-v="${k}" style="--c:${v.hex}" aria-label="${v.label}" title="${v.label}"><span></span></button>`).join('');
  $('[data-group="size"]').innerHTML = Object.keys(SIZES).map((k) => `<button class="size" type="button" data-v="${k}">${k}${k === 'M' ? '<i>Your size</i>' : ''}</button>`).join('');

  $$('[data-group]').forEach((group) => group.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const key = group.dataset.group;
    studioLook[key] = b.dataset.v;
    if (key === 'style') studioLook.fabric = STYLES[b.dataset.v].fabric;
    syncStudio();
  }));

  $('#heatmap').addEventListener('change', (e) => {
    scene?.setHeatmap(e.target.checked);
    $('#heatLegend').classList.toggle('show', e.target.checked);
  });
  $('#saveLook').addEventListener('click', () => toast(`Saved “${STYLES[studioLook.style].label}” to your wardrobe`));
  $('#randomLook').addEventListener('click', () => {
    const pick = (o) => { const k = Object.keys(o); return k[Math.floor(Math.random() * k.length)]; };
    let next;
    do { next = { style: pick(STYLES), fabric: pick(FABRICS), color: pick(COLORS) }; }
    while (next.style === studioLook.style && next.color === studioLook.color);
    Object.assign(studioLook, next);
    syncStudio();
  });

  // drag to rotate
  const zone = $('#dragZone');
  let lastX = null;
  zone.addEventListener('pointerdown', (e) => { lastX = e.clientX; zone.setPointerCapture(e.pointerId); });
  zone.addEventListener('pointermove', (e) => { if (lastX === null) return; scene?.drag(e.clientX - lastX); lastX = e.clientX; });
  const end = () => { lastX = null; };
  zone.addEventListener('pointerup', end);
  zone.addEventListener('pointercancel', end);

  syncStudio();
}

function syncStudio() {
  $$('[data-group]').forEach((g) => $$('button', g).forEach((b) => b.classList.toggle('active', b.dataset.v === studioLook[g.dataset.group])));
  const s = SIZES[studioLook.size];
  const fill = $('#fitFill');
  fill.style.width = `${s.fit}%`;
  fill.dataset.tone = s.tone;
  $('#fitText').textContent = `${s.text} · ${s.fit}% fit`;
  $('#lookName').textContent = `${STYLES[studioLook.style].label} · ${COLORS[studioLook.color].label} ${FABRICS[studioLook.fabric].label.toLowerCase()} · size ${studioLook.size}`;
  scene?.setStudioLook({ ...studioLook });
}
buildStudio();

/* ---------------- measurement demo ---------------- */
const RATIOS = [
  ['bust', 'Bust', 0.514], ['waist', 'Waist', 0.406], ['hips', 'Hips', 0.56], ['shoulder', 'Shoulders', 0.238],
  ['inseam', 'Inseam', 0.452], ['arm', 'Arm length', 0.343], ['neck', 'Neck', 0.205], ['thigh', 'Thigh', 0.322],
];
const mGrid = $('#mGrid');
mGrid.innerHTML = RATIOS.map(([k, l]) => `<div class="m-cell"><small>${l}</small><b data-m="${k}">0<span>cm</span></b></div>`).join('');
const shown = {};
let measuredLive = false;
const getHeight = () => clamp(parseFloat($('#heightIn').value) || 168, 130, 215);
const estimateFromHeight = (h) => Object.fromEntries(RATIOS.map(([k, , r]) => [k, h * r]));
function updateMeasures() {
  if (measuredLive) return; // camera values win once captured
  animateTo(estimateFromHeight(getHeight()));
}
function setMeasured(values) {
  measuredLive = true;
  animateTo(values);
  $('#mBadge').textContent = 'Measured by camera';
  $('#mBadge').classList.add('cam');
}
function animateTo(values) {
  RATIOS.forEach(([k]) => {
    if (values[k] == null) return;
    const target = values[k];
    const el = $(`[data-m="${k}"]`);
    const from = shown[k] ?? 0;
    const t0 = performance.now();
    const step = (t) => {
      const p = Math.min(1, (t - t0) / 700);
      const v = from + (target - from) * (1 - Math.pow(1 - p, 3));
      el.innerHTML = `${v.toFixed(1)}<span>cm</span>`;
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    shown[k] = target;
  });
  $$('.p-tag b').forEach((b) => { if (values[b.dataset.k] != null) b.textContent = `${values[b.dataset.k].toFixed(1)} cm`; });
}
function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
$('#heightIn').addEventListener('input', () => {
  measuredLive = false;
  $('#mBadge').textContent = 'Live estimate';
  $('#mBadge').classList.remove('cam');
  updateMeasures();
});
const mio = new IntersectionObserver((es) => { if (es[0].isIntersecting) { updateMeasures(); mio.disconnect(); } }, { threshold: 0.3 });
mio.observe(mGrid);

// fake scan progress inside the phone
const CUES = [[0, 'Face the camera'], [20, 'Turn slowly to your left'], [45, 'Show your side profile'], [70, 'Keep turning…'], [90, 'Almost there…']];
let pct = 0, done = 0;
setInterval(() => {
  if ($('#phone').classList.contains('live')) return; // real camera is driving the phone UI
  const cue = $('#scanCue');
  if (done > 0) {
    done--;
    if (done === 0) { pct = 0; cue.classList.remove('done'); $('#scanStatus').textContent = 'Scanning'; $$('.p-tag').forEach((t) => t.classList.remove('on')); }
    return;
  }
  pct = Math.min(100, pct + 1);
  $('#scanPct').textContent = `${pct}%`;
  cue.textContent = [...CUES].reverse().find(([p]) => pct >= p)[1];
  $$('.p-tag').forEach((t) => t.classList.toggle('on', pct >= +t.dataset.at));
  if (pct === 100) { cue.textContent = '✓ 24 measurements captured'; cue.classList.add('done'); $('#scanStatus').textContent = 'Complete'; done = 40; }
}, 70);

/* ---------------- real camera + profile ---------------- */
const profile = initProfile({ getMeasures: () => ({ ...shown }), getHeight, isMeasured: () => measuredLive, toast });
initCamera({
  getHeight,
  setHeight: (h) => { $('#heightIn').value = Math.round(h); },
  onMeasured: setMeasured,
  onSave: () => profile.open(),
  onStage: (open) => scene?.setActive(!open), // pause the 3D scene while the scan is full screen
  toast,
});

/* ---------------- waitlist ---------------- */
$('#wlForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const email = $('#wlEmail').value.trim();
  const msg = $('#wlMsg');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { msg.textContent = 'Please enter a valid email address.'; msg.className = 'fine err'; return; }
  msg.textContent = "You're on the list ✦ We'll be in touch when your invite is ready.";
  msg.className = 'fine ok';
  $('#wlEmail').value = '';
});

$('#yr').textContent = new Date().getFullYear();
