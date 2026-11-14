// "Create your profile" — preview version stores the profile only in this browser (localStorage).
// No photos are ever part of a profile: just a name, height, fit preference and measurements.

import { UNIT, fmtLen, heightToCm, heightField } from './units.js?v=27';
const $ = (s) => document.querySelector(s);
const KEY = 'mirra.profile.v1';
const LABELS = { bust: 'Bust', waist: 'Waist', hips: 'Hips', shoulder: 'Shoulders', inseam: 'Inseam', arm: 'Arm', neck: 'Neck', thigh: 'Thigh' };
// Upper limits per size, in cm. Women and men are cut differently, so each has its own chart.
// (There used to be one women's chart for everybody, which put nearly every man in the top size.)
// Women: bust and hips decide. Men: chest decides. A clearly bigger waist moves either up one size.
const CHARTS = {
  women: [
    { size: 'XS', eu: '34', bust: 82, waist: 66, hips: 90 },
    { size: 'S', eu: '36', bust: 88, waist: 72, hips: 96 },
    { size: 'M', eu: '38', bust: 94, waist: 78, hips: 102 },
    { size: 'L', eu: '40', bust: 100, waist: 84, hips: 108 },
    { size: 'XL', eu: '42', bust: 106, waist: 90, hips: 114 },
    { size: 'XXL', eu: '44+', bust: Infinity, waist: Infinity, hips: Infinity },
  ],
  men: [
    { size: 'XS', eu: '44', bust: 86, waist: 72 },
    { size: 'S', eu: '46', bust: 94, waist: 80 },
    { size: 'M', eu: '48-50', bust: 102, waist: 88 },
    { size: 'L', eu: '52-54', bust: 110, waist: 96 },
    { size: 'XL', eu: '56-58', bust: 118, waist: 106 },
    { size: 'XXL', eu: '60+', bust: Infinity, waist: Infinity },
  ],
};
export const SIZE_ORDER = CHARTS.women.map((r) => r.size);
const WHO_KEY = 'mirra.who';
/** 'women' or 'men': whose size chart to use (chosen on the size-scan card). */
export const whoFor = () => { try { return localStorage.getItem(WHO_KEY) === 'men' ? 'men' : 'women'; } catch { return 'women'; } };
export const setWhoFor = (w) => { try { localStorage.setItem(WHO_KEY, w === 'men' ? 'men' : 'women'); } catch { /* blocked */ } };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function recommendSize(m, who = whoFor()) {
  const men = who === 'men';
  if (!m || !m.bust || (!men && !m.hips)) return null;
  const table = CHARTS[men ? 'men' : 'women'];
  const at = (k, v) => { const i = table.findIndex((r) => v <= r[k]); return i < 0 ? table.length - 1 : i; };
  let idx = men ? at('bust', m.bust) : Math.max(at('bust', m.bust), at('hips', m.hips));
  // waist is the least reliable camera value: only let it raise the size by one, and only with a clear margin
  if (m.waist && at('waist', m.waist - 3) > idx) idx = Math.min(idx + 1, table.length - 1);
  return { ...table[idx], who: men ? 'men' : 'women' };
}

function load() { try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch { return null; } }
function save(p) { try { localStorage.setItem(KEY, JSON.stringify(p)); return true; } catch { return false; } }
function remove() { try { localStorage.removeItem(KEY); } catch { /* storage blocked */ } }

export function initProfile({ getMeasures, getHeight, isMeasured, toast }) {
  const modal = $('#profileModal'), form = $('#profileForm'), navBtn = $('#profileBtn');
  const nameIn = $('#pfName'), heightIn = $('#pfHeight'), list = $('#pfMeasures'), rec = $('#pfRec'), src = $('#pfSource');
  const delBtn = $('#pfDelete'), title = $('#pfTitle');
  let draft = {};

  function renderNav() {
    const p = load();
    navBtn.innerHTML = p
      ? `<span class="avatar">${esc(p.name.trim()[0] || 'M').toUpperCase()}</span>${esc(p.name.split(' ')[0])}`
      : 'Create profile';
  }

  function renderMeasures() {
    const entries = Object.entries(draft.measurements || {}).filter(([k, v]) => LABELS[k] && v > 0);
    list.innerHTML = entries.length
      ? entries.map(([k, v]) => `<div><small>${LABELS[k]}</small><b>${fmtLen(v)}<span>${UNIT}</span></b></div>`).join('')
      : '<p class="fine">No measurements yet. Tap Find my size.</p>';
    const r = recommendSize(draft.measurements);
    rec.innerHTML = r ? `<small>Recommended size</small><b>${r.size} · EU ${r.eu}</b>` : '';
    src.textContent = draft.source === 'camera' ? 'From your camera scan' : 'Estimated from your height';
    src.className = `badge ${draft.source === 'camera' ? 'cam' : ''}`;
  }

  function open() {
    const saved = load();
    const live = getMeasures();
    const hasLive = Object.values(live).some((v) => v > 0);
    draft = {
      name: saved?.name || '',
      height: saved?.height || getHeight(),
      fit: saved?.fit || 'regular',
      // freshly scanned numbers take priority over older saved ones
      measurements: isMeasured() || !saved?.measurements ? (hasLive ? live : saved?.measurements || {}) : saved.measurements,
      source: isMeasured() ? 'camera' : saved?.source || 'estimate',
    };
    nameIn.value = draft.name;
    heightIn.value = heightField(draft.height);
    form.querySelectorAll('input[name="fit"]').forEach((r) => { r.checked = r.value === draft.fit; });
    title.textContent = saved ? 'Your profile' : 'Create your profile';
    delBtn.hidden = !saved;
    renderMeasures();
    modal.classList.add('open');
    setTimeout(() => nameIn.focus(), 50);
  }
  const close = () => modal.classList.remove('open');

  navBtn.addEventListener('click', open);
  document.querySelectorAll('[data-open-profile]').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); open(); }));
  modal.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  addEventListener('keydown', (e) => { if (e.key === 'Escape') document.querySelectorAll('.modal.open').forEach((m) => m.classList.remove('open')); });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = nameIn.value.trim();
    if (!name) { nameIn.focus(); nameIn.classList.add('err'); return; }
    nameIn.classList.remove('err');
    const profile = {
      name: name.slice(0, 60),
      height: Math.min(215, Math.max(130, heightToCm(heightIn.value) || 168)),
      fit: form.querySelector('input[name="fit"]:checked')?.value || 'regular',
      measurements: draft.measurements,
      source: draft.source,
      savedAt: new Date().toISOString(),
    };
    if (save(profile)) toast(`Welcome, ${profile.name.split(' ')[0]} — profile saved on this device`);
    else toast('Could not save — browser storage is blocked');
    renderNav();
    close();
  });

  delBtn.addEventListener('click', () => {
    remove();
    renderNav();
    close();
    toast('Profile deleted');
  });

  renderNav();
  return { open };
}
