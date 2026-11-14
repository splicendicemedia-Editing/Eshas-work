// How lengths are shown to people. Everything is measured and stored in centimetres inside;
// this file only decides the display. It follows the choice on the size-scan card:
//   "metres"  -> 0.96 m, height 1.72 m
//   "ft / in" -> 38.0 in, height 5 ft 8 in
const saved = () => { try { return localStorage.getItem('mirra.unit') === 'ft' ? 'in' : 'm'; } catch { return 'm'; } };

/** 'm' or 'in'. A live value: files that import it always see the current choice. */
export let UNIT = saved();

/** Called when the person picks metres ('cm') or feet and inches ('ft'). */
export function useUnits(choice) {
  const next = choice === 'ft' ? 'in' : 'm';
  if (next === UNIT) return;
  UNIT = next;
  dispatchEvent(new CustomEvent('mirra:units')); // anything already on screen redraws itself
}

/** 96.4 (cm) -> "0.96" or "38.0" */
export const fmtLen = (cm) => (UNIT === 'in' ? (cm / 2.54).toFixed(1) : (cm / 100).toFixed(2));
/** 96.4 (cm) -> "0.96 m" or "38.0 in" */
export const withUnit = (cm) => `${fmtLen(cm)} ${UNIT}`;
/** A height: 172 (cm) -> "1.72 m" or "5 ft 8 in" */
export function heightText(cm) {
  if (UNIT !== 'in') return `${(cm / 100).toFixed(2)} m`;
  let ft = Math.floor(cm / 30.48), inch = Math.round(cm / 2.54 - ft * 12);
  if (inch === 12) { ft++; inch = 0; }
  return `${ft} ft ${inch} in`;
}

/**
 * What someone typed as their height -> centimetres.
 * Understands 1.68 and 168 (metres, centimetres) and 5'8", 5 ft 8, 5 8, 5.8 (feet and inches).
 */
export function heightToCm(text) {
  const s = String(text).trim().toLowerCase().replace(',', '.');
  const fi = /^(\d)\s*(?:ft|feet|foot|'|′)\s*(\d{1,2}(?:\.\d+)?)?\s*(?:in|inch|inches|"|″|'')?$/.exec(s) || /^(\d)\s+(\d{1,2})$/.exec(s);
  if (fi) return (parseInt(fi[1], 10) * 12 + parseFloat(fi[2] || '0')) * 2.54;
  const v = parseFloat(s);
  if (!isFinite(v)) return NaN;
  if (v > 0 && v < 3) return v * 100;                       // metres
  if (v >= 3 && v < 9) {                                     // 5.8 or 5.11 typed for 5 ft 8 in / 5 ft 11 in
    const ft = Math.floor(v), inch = parseInt((s.split('.')[1] || '0').slice(0, 2), 10) || 0;
    return (ft * 12 + Math.min(inch, 11)) * 2.54;
  }
  return v;                                                  // centimetres
}
/** A height for a free-text box, in the chosen units: 1.72 or 5'8" */
export function heightField(cm) {
  if (UNIT !== 'in') return (cm / 100).toFixed(2);
  let ft = Math.floor(cm / 30.48), inch = Math.round(cm / 2.54 - ft * 12);
  if (inch === 12) { ft++; inch = 0; }
  return `${ft}'${inch}"`;
}
/** 168 (cm) -> "1.68" for the metres height box */
export const heightBox = (cm) => (cm / 100).toFixed(2);
