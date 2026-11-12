// Shared garment catalogue used by the 3D scene and the studio UI.
// Units are scene units (1 ≈ 1 metre on the dress form). y = 0 is the hip base, the neck is ≈ 1.1,
// the platform floor is ≈ -1.15.
//
// Style fields
//   top/bottom   garment body from neckline (or bust for strapless) down to the hem
//   neck         { y, dip }: neckline height at the sides/back and how far it dips at the front
//   flare/flarePow, pleat/pleats, sway: skirt shape and movement
//   straps       thin shoulder straps
//   sleeves      { len, r0, r1 }: hanging sleeve length and radius at shoulder / cuff
//   slits        y where the kameez side slits start
//   midriff      [from, to]: bare band (lehenga choli)
//   trousers     { kind: 'shalwar' | 'slim' | 'wide' }
//   dupatta      draped scarf around the shoulders
//   pattern      default surface: 'plain' | 'print' | 'embroidery'

export const COLLECTIONS = {
  pk: { label: 'Pakistani', flag: 'Desi wear' },
  uk: { label: 'British', flag: 'UK classics' },
  us: { label: 'American', flag: 'US favourites' },
};

export const STYLES = {
  // Pakistani
  shalwar:   { label: 'Shalwar Kameez', region: 'pk', neck: { y: 0.975, dip: 0.07 }, bottom: -0.5, flare: 0.07, flarePow: 1.2, pleat: 0.008, pleats: 6, sway: 0.5,
               sleeves: { len: 0.5, r0: 0.07, r1: 0.055 }, slits: 0.02, trousers: { kind: 'shalwar' }, dupatta: true, fabric: 'lawn', pattern: 'print', color: 'mustard' },
  anarkali:  { label: 'Anarkali', region: 'pk', neck: { y: 0.975, dip: 0.09 }, bottom: -1.11, flare: 0.62, flarePow: 1.15, pleat: 0.06, pleats: 26, sway: 1.1, waist: 0.6,
               sleeves: { len: 0.62, r0: 0.066, r1: 0.045 }, dupatta: true, fabric: 'chiffon', pattern: 'embroidery', color: 'rani' },
  kurti:     { label: 'Kurti & Cigarette Pants', region: 'pk', neck: { y: 0.975, dip: 0.1 }, bottom: -0.3, flare: 0.05, flarePow: 1.2, pleat: 0.006, pleats: 6, sway: 0.4,
               sleeves: { len: 0.44, r0: 0.066, r1: 0.05 }, slits: 0.0, trousers: { kind: 'slim' }, fabric: 'lawn', pattern: 'print', color: 'ivory' },
  lehenga:   { label: 'Lehenga Choli', region: 'pk', neck: { y: 0.965, dip: 0.12 }, bottom: -1.11, flare: 0.66, flarePow: 1.05, pleat: 0.05, pleats: 30, sway: 1.0, waist: 0.52,
               sleeves: { len: 0.22, r0: 0.068, r1: 0.06 }, midriff: [0.535, 0.62], dupatta: true, fabric: 'velvet', pattern: 'embroidery', color: 'bordeaux' },
  // British
  tea:       { label: 'Tea Dress', region: 'uk', neck: { y: 0.95, dip: 0.14 }, bottom: -0.72, flare: 0.22, flarePow: 1.3, pleat: 0.025, pleats: 12, sway: 1.0,
               sleeves: { len: 0.18, r0: 0.075, r1: 0.085 }, fabric: 'crepe', pattern: 'print', color: 'sky' },
  ascot:     { label: 'Fit & Flare Midi', region: 'uk', neck: { y: 0.94, dip: 0.04 }, bottom: -0.66, flare: 0.3, flarePow: 1.4, pleat: 0.035, pleats: 14, sway: 0.8,
               fabric: 'crepe', pattern: 'plain', color: 'emerald' },
  pleated:   { label: 'Pleated Midi', region: 'uk', top: 0.78, bottom: -0.72, flare: 0.16, flarePow: 1.3, pleat: 0.07, pleats: 34, sway: 0.8, straps: true, fabric: 'crepe', pattern: 'plain', color: 'blush' },
  // American
  gown:      { label: 'Evening Gown', region: 'us', top: 0.80, bottom: -1.10, flare: 0.42, flarePow: 1.5, pleat: 0.05, pleats: 11, sway: 1.2, fabric: 'velvet', pattern: 'plain', color: 'bordeaux' },
  slip:      { label: 'Silk Slip', region: 'us', top: 0.76, bottom: -0.62, flare: 0.10, flarePow: 1.6, pleat: 0.025, pleats: 9, sway: 1.0, straps: true, fabric: 'silk', pattern: 'plain', color: 'champagne' },
  sundress:  { label: 'Sundress', region: 'us', top: 0.8, bottom: -0.42, flare: 0.24, flarePow: 1.1, pleat: 0.03, pleats: 10, sway: 0.9, straps: true, fabric: 'linen', pattern: 'print', color: 'ivory' },
  jumpsuit:  { label: 'Wide-leg Jumpsuit', region: 'us', top: 0.8, bottom: -0.1, flare: 0.0, flarePow: 1.2, pleat: 0.004, pleats: 6, sway: 0.2, straps: true,
               trousers: { kind: 'wide' }, fabric: 'crepe', pattern: 'plain', color: 'noir' },
};

export const FABRICS = {
  lawn:    { label: 'Lawn cotton',    roughness: 0.82, sheen: 0.3,  sheenRoughness: 0.7,  sheenMix: 0.25, bump: 0.8 },
  chiffon: { label: 'Chiffon',        roughness: 0.55, sheen: 0.9,  sheenRoughness: 0.35, sheenMix: 0.45, bump: 0.3 },
  silk:    { label: 'Satin silk',     roughness: 0.30, sheen: 1.0,  sheenRoughness: 0.25, sheenMix: 0.55, bump: 0.25 },
  velvet:  { label: 'Velvet',         roughness: 0.95, sheen: 1.0,  sheenRoughness: 0.55, sheenMix: 0.12, bump: 0.35 },
  linen:   { label: 'Linen',          roughness: 0.88, sheen: 0.25, sheenRoughness: 0.8,  sheenMix: 0.2,  bump: 1.2 },
  crepe:   { label: 'Crepe',          roughness: 0.70, sheen: 0.5,  sheenRoughness: 0.5,  sheenMix: 0.3,  bump: 0.6 },
};

export const PATTERNS = {
  plain:      { label: 'Plain' },
  print:      { label: 'Floral print' },
  embroidery: { label: 'Embroidered' },
};

export const COLORS = {
  ivory:     { label: 'Ivory',     hex: '#ece2d0' },
  champagne: { label: 'Champagne', hex: '#d6b58a' },
  mustard:   { label: 'Mustard',   hex: '#c9952b' },
  blush:     { label: 'Blush',     hex: '#e2a7a2' },
  rani:      { label: 'Rani pink', hex: '#b8195a' },
  bordeaux:  { label: 'Bordeaux',  hex: '#6e1427' },
  emerald:   { label: 'Emerald',   hex: '#0f5a46' },
  sky:       { label: 'Sky',       hex: '#8fb4d9' },
  royal:     { label: 'Royal blue', hex: '#1f3a8a' },
  noir:      { label: 'Noir',      hex: '#1b1920' },
};

// ease = distance between garment and body (scene units). M is the "recommended" size.
export const SIZES = {
  XS: { ease: 0.003, fit: 61, tone: 'bad',  text: 'Too tight at bust & hips' },
  S:  { ease: 0.008, fit: 84, tone: 'warn', text: 'Snug at the bust' },
  M:  { ease: 0.013, fit: 96, tone: 'good', text: 'Ideal fit' },
  L:  { ease: 0.022, fit: 82, tone: 'warn', text: 'Relaxed at the waist' },
  XL: { ease: 0.034, fit: 64, tone: 'bad',  text: 'Loose overall' },
};

export const lookFor = (style, size = 'M') => {
  const s = STYLES[style];
  return { style, fabric: s.fabric, color: s.color, pattern: s.pattern, size };
};

export const LOOKBOOK = ['shalwar', 'gown', 'anarkali', 'tea', 'lehenga', 'jumpsuit', 'kurti', 'slip', 'sundress'].map((s) => lookFor(s));
