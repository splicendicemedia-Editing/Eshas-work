// "Create your profile" — preview version stores the profile only in this browser (localStorage).
// No photos are ever part of a profile: just a name, height, fit preference and measurements.

import { UNIT, fmtLen, heightToCm, heightField } from './units.js?v=30';
const $ = (s) => document.querySelector(s);
const KEY = 'mirra.profile.v1';
const LABELS = { bust: 'Bust', waist: 'Waist', hips: 'Hips', shoulder: 'Shoulders', inseam: 'Inseam', arm: 'Arm', neck: 'Neck', thigh: 'Thigh' };
// European standard sizes (body measurements in the style of EN 13402; upper limits in cm), with the
// UK and US numbers that shops print next to them. Each EU size is its own step, so nobody is pushed
// into a letter that covers two or three sizes.
// Women: bust and hips decide. Men: chest decides (EU size = half the chest in cm). A clearly bigger
// waist moves either up one size.
const CHARTS = {
  women: [
    [32, 78, 62, 86], [34, 82, 66, 90], [36, 86, 70, 94], [38, 90, 74, 98], [40, 94, 78, 102], [42, 98, 82, 106],
    [44, 102, 86, 110], [46, 107, 91.5, 115], [48, 113, 98, 121], [50, 119, 104, 127], [52, 125, 110, 132], [54, Infinity, Infinity, Infinity],
  ].map(([eu, bust, waist, hips]) => ({ eu, bust, waist, hips })),
  men: [
    [42, 86, 74], [44, 90, 78], [46, 94, 82], [48, 98, 86], [50, 102, 90], [52, 106, 94], [54, 110, 98],
    [56, 114, 104], [58, 118, 110], [60, 122, 116], [62, Infinity, Infinity],
  ].map(([eu, bust, waist]) => ({ eu, bust, waist })),
};
// the letter printed on most labels for each EU size
const LETTER = {
  women: (eu) => (eu <= 34 ? 'XS' : eu === 36 ? 'S' : eu === 38 ? 'M' : eu === 40 ? 'L' : eu === 42 ? 'XL' : eu === 44 ? 'XXL' : eu === 46 ? '3XL' : eu === 48 ? '4XL' : '5XL'),
  men: (eu) => (eu <= 42 ? 'XS' : eu <= 46 ? 'S' : eu <= 50 ? 'M' : eu <= 54 ? 'L' : eu <= 58 ? 'XL' : 'XXL'),
};
export const SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];
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
  const eu = table[idx].eu, last = idx === table.length - 1 ? '+' : '';
  const out = { size: LETTER[men ? 'men' : 'women'](eu), eu: `${eu}${last}`, who: men ? 'men' : 'women' };
  if (men) {
    out.uk = out.us = String(2 * Math.round(m.bust / 2.54 / 2)); // UK and US jackets and shirts go by chest in inches
    if (m.waist) { out.trouserW = 2 * Math.round(m.waist / 2.54 / 2); out.trouserEu = out.trouserW + 16; }
  } else {
    out.uk = `${eu - 28}${last}`; out.us = `${Math.max(0, eu - 32)}${last}`;
  }
  return out;
}
/** The same size in each system, as short labels: ["EU 38", "UK 10", "US 6"] */
export function sizeSystems(r) {
  if (!r) return [];
  const list = r.who === 'men' ? [`EU ${r.eu}`, `UK / US ${r.uk}`] : [`EU ${r.eu}`, `UK ${r.uk}`, `US ${r.us}`];
  if (r.trouserW) list.push(`Trousers W${r.trouserW} · EU ${r.trouserEu}`);
  return list;
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
    rec.innerHTML = r ? `<small>Recommended size</small><b>${r.size} · ${sizeSystems(r).join(' · ')}</b>` : '';
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
