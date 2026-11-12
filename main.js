import { STYLES, FABRICS, COLORS, SIZES, PATTERNS, COLLECTIONS, PHOTOS, photoUrl, lookFor } from './catalog.js?v=18';
import { initCamera } from './camera.js?v=18';
import { initProfile, recommendSize, SIZE_ORDER } from './profile.js?v=18';
import { initMirror } from './mirror.js?v=18';

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
const studioLook = lookFor('shalwar');
let collection = 'pk';
let scene = null;

import('./scene.js?v=18')
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

/* ---------------- live mirror (try it on yourself) ---------------- */
const mirror = initMirror({ onStage: (open) => scene?.setActive(!open), toast });

/* ---------------- studio controls ---------------- */
function buildStudio() {
  // collections: Pakistani / British / American
  $('#collTabs').innerHTML = Object.entries(COLLECTIONS).map(([k, v]) => `<button type="button" role="tab" data-coll="${k}"><b>${v.label}</b><small>${v.flag}</small></button>`).join('');
  $('#collTabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-coll]');
    if (!b || b.dataset.coll === collection) return;
    collection = b.dataset.coll;
    renderOutfits();
    setView('photo');
    const first = Object.keys(STYLES).find((k) => STYLES[k].region === collection);
    Object.assign(studioLook, lookFor(first, studioLook.size));
    syncStudio();
  });
  renderOutfits();
  $('[data-group="pattern"]').innerHTML = Object.entries(PATTERNS).map(([k, v]) => `<button class="chip" type="button" data-v="${k}">${v.label}</button>`).join('');
  $('[data-group="fabric"]').innerHTML = Object.entries(FABRICS).map(([k, v]) => `<button class="chip" type="button" data-v="${k}">${v.label}</button>`).join('');
  $('[data-group="color"]').innerHTML = Object.entries(COLORS).map(([k, v]) => `<button class="swatch" type="button" data-v="${k}" style="--c:${v.hex}" aria-label="${v.label}" title="${v.label}"><span></span></button>`).join('');
  renderSizes();

  $$('[data-group]').forEach((group) => group.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const key = group.dataset.group;
    // picking an outfit loads its signature fabric, pattern and colour; the size stays
    // an outfit shows its real model photo; fabric / pattern / colour / size are checked on the 3D form
    if (key === 'style') { Object.assign(studioLook, lookFor(b.dataset.v, studioLook.size)); setView('photo'); }
    else { studioLook[key] = b.dataset.v; setView('3d'); }
    syncStudio();
  }));

  $('#heatmap').addEventListener('change', (e) => {
    if (e.target.checked) setView('3d');
    scene?.setHeatmap(e.target.checked);
    $('#heatLegend').classList.toggle('show', e.target.checked);
  });
  $('#tryOnMe').addEventListener('click', () => mirror.open({ ...studioLook }));

  // first screen: three real looks; tap one to try it on yourself
  $('#heroPhotos').innerHTML = ['shalwar', 'anarkali', 'gown'].map((k) => `<figure data-hero-look="${k}" tabindex="0" role="button" aria-label="Try the ${STYLES[k].label} on yourself">
      <img src="${photoUrl(k, 560)}" alt="${PHOTOS[k].alt}" decoding="async">
      <span class="try-pill">Try it on me</span>
      <figcaption><small>${COLLECTIONS[STYLES[k].region].label}</small><b>${STYLES[k].label}</b></figcaption></figure>`).join('');
  $('#heroPhotos').addEventListener('click', (e) => { const f = e.target.closest('[data-hero-look]'); if (f) mirror.open(lookFor(f.dataset.heroLook)); });
  $('#heroPhotos').addEventListener('keydown', (e) => { const f = e.target.closest('[data-hero-look]'); if (f && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); mirror.open(lookFor(f.dataset.heroLook)); } });
  $('#randomLook').addEventListener('click', () => {
    const pick = (o) => { const k = Object.keys(o); return k[Math.floor(Math.random() * k.length)]; };
    let next;
    do { next = { ...lookFor(pick(STYLES), studioLook.size), color: pick(COLORS), pattern: pick(PATTERNS) }; }
    while (next.style === studioLook.style && next.color === studioLook.color);
    Object.assign(studioLook, next);
    if (STYLES[next.style].region !== collection) { collection = STYLES[next.style].region; renderOutfits(); }
    setView('3d');
    syncStudio();
  });

  // drag to rotate
  const zone = $('#dragZone');
  let lastX = null;
  zone.addEventListener('pointerdown', (e) => { if (studioView !== '3d' || e.target.closest('.view-toggle')) return; lastX = e.clientX; zone.setPointerCapture(e.pointerId); });
  $('#viewToggle').addEventListener('click', (e) => { const b = e.target.closest('[data-view]'); if (b) setView(b.dataset.view); });
  $('#modelImg').addEventListener('load', (e) => e.target.classList.add('in'));

  // real-photo lookbook rail: tap a look to open it in the studio
  $('#looksRail').innerHTML = Object.entries(STYLES).map(([k, v]) => `<button class="look-card" type="button" data-look="${k}">
      <img src="${photoUrl(k, 480)}" alt="${PHOTOS[k].alt}" loading="lazy" decoding="async">
      <span><small>${COLLECTIONS[v.region].label}</small><b>${v.label}</b></span></button>`).join('');
  $('#looksRail').addEventListener('click', (e) => {
    const b = e.target.closest('[data-look]');
    if (!b) return;
    const st = b.dataset.look;
    collection = STYLES[st].region; renderOutfits();
    Object.assign(studioLook, lookFor(st, studioLook.size));
    setView('photo'); syncStudio();
    $('#studio').scrollIntoView({ behavior: 'smooth' });
  });
  zone.addEventListener('pointermove', (e) => { if (lastX === null) return; scene?.drag(e.clientX - lastX); lastX = e.clientX; });
  const end = () => { lastX = null; };
  zone.addEventListener('pointerup', end);
  zone.addEventListener('pointercancel', end);

  syncStudio();
}

// Fit is relative to the shopper's own size: before a scan the demo assumes M,
// after a scan "Your size" moves to the recommended size and every other size is judged against it.
let mySize = null;
const SIZE_KEYS = Object.keys(SIZES); // XS..XL, M in the middle = ideal ease
function fitKeyFor(size) {
  const base = mySize || 'M';
  const diff = SIZE_ORDER.indexOf(size) - SIZE_ORDER.indexOf(base);
  return SIZE_KEYS[clamp(2 + diff, 0, SIZE_KEYS.length - 1)];
}
function renderSizes() {
  const mine = mySize || 'M';
  $('[data-group="size"]').innerHTML = SIZE_KEYS.map((k) => `<button class="size" type="button" data-v="${k}">${k}${k === mine ? `<i>${mySize ? 'Your size' : 'Typical'}</i>` : ''}</button>`).join('');
}
function renderOutfits() {
  $$('#collTabs [data-coll]').forEach((b) => { const on = b.dataset.coll === collection; b.classList.toggle('active', on); b.setAttribute('aria-selected', String(on)); });
  $('[data-group="style"]').innerHTML = Object.entries(STYLES).filter(([, v]) => v.region === collection)
    .map(([k, v]) => `<button class="chip" type="button" data-v="${k}">${v.label}</button>`).join('');
}
// 'photo' = real model photo of the outfit, '3d' = the fit check on the dress form
let studioView = 'photo';
function setView(v) {
  studioView = v === '3d' ? '3d' : 'photo';
  $('#dragZone').dataset.view = studioView;
  $$('#viewToggle [data-view]').forEach((b) => { const on = b.dataset.view === studioView; b.classList.toggle('active', on); b.setAttribute('aria-selected', String(on)); });
  scene?.setPhotoMode(studioView === 'photo');
}
function syncStudio() {
  const img = $('#modelImg'), src = photoUrl(studioLook.style, 900);
  if (img.getAttribute('src') !== src) { img.classList.remove('in'); img.src = src; img.alt = PHOTOS[studioLook.style].alt; }
  $('#modelName').textContent = STYLES[studioLook.style].label;
  $$('[data-group]').forEach((g) => $$('button', g).forEach((b) => b.classList.toggle('active', b.dataset.v === studioLook[g.dataset.group])));
  const s = SIZES[fitKeyFor(studioLook.size)];
  const fill = $('#fitFill');
  fill.style.width = `${s.fit}%`;
  fill.dataset.tone = s.tone;
  const text = mySize && studioLook.size === mySize ? 'Your size — ideal fit' : s.text;
  $('#fitText').textContent = `${text} · ${s.fit}% fit`;
  const pat = studioLook.pattern && studioLook.pattern !== 'plain' ? ` · ${PATTERNS[studioLook.pattern].label.toLowerCase()}` : '';
  $('#lookName').textContent = `${STYLES[studioLook.style].label} · ${COLORS[studioLook.color].label} ${FABRICS[studioLook.fabric].label.toLowerCase()}${pat} · size ${studioLook.size}`;
  // the 3D garment drapes with the ease of the *relative* fit, so a size that is too small looks tight on you
  scene?.setStudioLook({ ...studioLook, size: fitKeyFor(studioLook.size) });
}
function setMySize(size) {
  if (!size || !SIZES[size]) return;
  mySize = size;
  studioLook.size = size;
  renderSizes();
  syncStudio();
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
let exactHeight = null;
const getHeight = () => {
  const v = parseFloat($('#heightIn').value) || 168;
  return clamp(exactHeight && Math.round(exactHeight) === Math.round(v) ? exactHeight : v, 130, 215);
};
const estimateFromHeight = (h) => Object.fromEntries(RATIOS.map(([k, , r]) => [k, h * r]));
function updateMeasures() {
  if (measuredLive) return; // camera values win once captured
  animateTo(estimateFromHeight(getHeight()));
}
function setMeasured(values) {
  measuredLive = true;
  animateTo(values);
  setMySize(recommendSize(values)?.size);
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
function showFeet() {
  const h = parseFloat($('#heightIn').value);
  if (!(h >= 130 && h <= 215)) { $('#heightFt').textContent = ''; return; }
  let ft = Math.floor(h / 30.48), inch = Math.round(h / 2.54 - ft * 12);
  if (inch === 12) { ft++; inch = 0; }
  $('#heightFt').textContent = `≈ ${ft} ft ${inch} in`;
}
showFeet();
$('#heightIn').addEventListener('input', () => {
  showFeet();
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
  if (pct === 100) { cue.textContent = '✓ 9 measurements captured'; cue.classList.add('done'); $('#scanStatus').textContent = 'Complete'; done = 40; }
}, 70);

/* ---------------- real camera + profile ---------------- */
const profile = initProfile({ getMeasures: () => ({ ...shown }), getHeight, isMeasured: () => measuredLive, toast });
initCamera({
  getHeight,
  // keep the exact height (ft/in converts to fractional cm); the field shows it rounded
  setHeight: (h) => { exactHeight = h; $('#heightIn').value = Math.round(h); showFeet(); updateMeasures(); },
  onMeasured: setMeasured,
  onSave: () => profile.open(),
  onTry: (size) => { setMySize(size); $('#studio').scrollIntoView({ behavior: 'smooth' }); },
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
