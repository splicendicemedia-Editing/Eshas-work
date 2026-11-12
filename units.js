// How lengths are shown to people. Everything is measured and stored in centimetres inside;
// this file only decides the display. The owner chose metres (13 November 2026).
export const UNIT = 'm';

/** 96.4 (cm) -> "0.96" */
export const fmtLen = (cm) => (UNIT === 'm' ? (cm / 100).toFixed(2) : cm.toFixed(1));
/** 96.4 (cm) -> "0.96 m" */
export const withUnit = (cm) => `${fmtLen(cm)} ${UNIT}`;

/** What someone typed as their height -> centimetres. "1.68" and "168" both mean 168 cm. */
export function heightToCm(text) {
  const v = parseFloat(String(text).replace(',', '.'));
  if (!isFinite(v)) return NaN;
  return v > 0 && v < 3 ? v * 100 : v;
}
/** 168 (cm) -> "1.68" for a height box */
export const heightBox = (cm) => (cm / 100).toFixed(2);
