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

/** What someone typed as their height in the metres box -> centimetres. "1.68" and "168" both mean 168 cm. */
export function heightToCm(text) {
  const v = parseFloat(String(text).replace(',', '.'));
  if (!isFinite(v)) return NaN;
  return v > 0 && v < 3 ? v * 100 : v;
}
/** 168 (cm) -> "1.68" for the metres height box */
export const heightBox = (cm) => (cm / 100).toFixed(2);
