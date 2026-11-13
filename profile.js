// "Create your profile" — preview version stores the profile only in this browser (localStorage).
// No photos are ever part of a profile: just a name, height, fit preference and measurements.

import { UNIT, fmtLen, heightToCm, heightBox } from './units.js?v=25';
const $ = (s) => document.querySelector(s);
const KEY = 'mirra.profile.v1';
const LABELS = { bust: 'Bust', waist: 'Waist', hips: 'Hips', shoulder: 'Shoulders', inseam: 'Inseam', arm: 'Arm', neck: 'Neck', thigh: 'Thigh' };
// upper limits per size (cm). Bust and hips decide; waist only pushes up when it is clearly bigger.
const SIZE_TABLE = [
  { size: 'XS', eu: 34, bust: 82, waist: 66, hips: 90 },
  { size: 'S', eu: 36, bust: 88, waist: 72, hips: 96 },
  { size: 'M', eu: 38, bust: 94, waist: 78, hips: 102 },
  { size: 'L', eu: 40, bust: 100, waist: 84, hips: 108 },
  { size: 'XL', eu: 42, bust: Infinity, waist: Infinity, hips: Infinity },
];
export const SIZE_ORDER = SIZE_TABLE.map((r) => r.size);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function recommendSize(m) {
  if (!m || !m.bust || !m.hips) return null;
  const at = (k, v) => SIZE_TABLE.findIndex((r) => v <= r[k]);
  let idx = Math.max(at('bust', m.bust), at('hips', m.hips));
  // waist is the least reliable camera value: only let it raise the size by one, and only with a clear margin
  if (m.waist && at('waist', m.waist - 3) > idx) idx = Math.min(idx + 1, SIZE_TABLE.length - 1);
  return SIZE_TABLE[idx < 0 ? SIZE_TABLE.length - 1 : idx];
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
      : '<p class="fine">No measurements yet — scan with your camera or enter your height.</p>';
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
    heightIn.value = heightBox(draft.height);
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
