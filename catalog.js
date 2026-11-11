// Shared garment catalogue used by the 3D scene and the studio UI.
// Units are scene units (1 ≈ 1 metre on the dress form).

export const STYLES = {
  slip:    { label: 'Silk Slip',    top: 0.76, bottom: -0.62, flare: 0.10, flarePow: 1.6, pleat: 0.025, pleats: 9,  sway: 1.0, straps: true,  fabric: 'silk' },
  gown:    { label: 'Evening Gown', top: 0.80, bottom: -1.10, flare: 0.42, flarePow: 1.5, pleat: 0.05,  pleats: 11, sway: 1.2, straps: false, fabric: 'velvet' },
  mini:    { label: 'A-line Mini',  top: 0.87, bottom: -0.18, flare: 0.16, flarePow: 1.1, pleat: 0.015, pleats: 7,  sway: 0.6, straps: false, fabric: 'linen' },
  pleated: { label: 'Pleated Midi', top: 0.78, bottom: -0.72, flare: 0.16, flarePow: 1.3, pleat: 0.07,  pleats: 34, sway: 0.8, straps: true,  fabric: 'crepe' },
};

export const FABRICS = {
  silk:   { label: 'Satin silk',     roughness: 0.30, sheen: 1.0,  sheenRoughness: 0.25, sheenMix: 0.55, bump: 0.25 },
  velvet: { label: 'Crushed velvet', roughness: 0.95, sheen: 1.0,  sheenRoughness: 0.55, sheenMix: 0.12, bump: 0.35 },
  linen:  { label: 'Washed linen',   roughness: 0.88, sheen: 0.25, sheenRoughness: 0.8,  sheenMix: 0.2,  bump: 1.2 },
  crepe:  { label: 'Crepe',          roughness: 0.70, sheen: 0.5,  sheenRoughness: 0.5,  sheenMix: 0.3,  bump: 0.6 },
};

export const COLORS = {
  champagne: { label: 'Champagne', hex: '#d6b58a' },
  noir:      { label: 'Noir',      hex: '#1b1920' },
  bordeaux:  { label: 'Bordeaux',  hex: '#6e1427' },
  emerald:   { label: 'Emerald',   hex: '#0f5a46' },
  sky:       { label: 'Sky',       hex: '#8fb4d9' },
  blush:     { label: 'Blush',     hex: '#e2a7a2' },
};

// ease = distance between garment and body (scene units). M is the "recommended" size.
export const SIZES = {
  XS: { ease: 0.003, fit: 61, tone: 'bad',  text: 'Too tight at bust & hips' },
  S:  { ease: 0.008, fit: 84, tone: 'warn', text: 'Snug at the bust' },
  M:  { ease: 0.013, fit: 96, tone: 'good', text: 'Ideal fit' },
  L:  { ease: 0.022, fit: 82, tone: 'warn', text: 'Relaxed at the waist' },
  XL: { ease: 0.034, fit: 64, tone: 'bad',  text: 'Loose overall' },
};

export const LOOKBOOK = [
  { style: 'gown',    fabric: 'velvet', color: 'bordeaux',  size: 'M' },
  { style: 'slip',    fabric: 'silk',   color: 'champagne', size: 'M' },
  { style: 'mini',    fabric: 'linen',  color: 'sky',       size: 'M' },
  { style: 'pleated', fabric: 'crepe',  color: 'emerald',   size: 'M' },
  { style: 'slip',    fabric: 'velvet', color: 'noir',      size: 'M' },
  { style: 'gown',    fabric: 'silk',   color: 'blush',     size: 'M' },
];
