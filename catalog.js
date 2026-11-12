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

// Men's wear. Same fields as STYLES plus:
//   cut: 'straight'  no bust or hip shaping
//   collar           'shirt' | 'ban' (band collar)
//   placket          how far down the front buttons run (catalogue y)
//   vest             waistcoat worn over the kameez
//   trousers.color   fixed trouser colour (jeans, dress trousers)
export const MEN = {
  m_shalwar:   { label: 'Shalwar Kameez', gender: 'men', region: 'pk', cut: 'straight', neck: { y: 0.975, dip: 0.035 }, collar: 'shirt', placket: 0.5,
                 bottom: -0.56, flare: 0.03, flarePow: 1, pleat: 0.004, pleats: 6, sway: 0, sleeves: { len: 0.62, r0: 0.078, r1: 0.06 },
                 trousers: { kind: 'shalwar' }, fabric: 'lawn', pattern: 'plain', color: 'white' },
  m_kurta:     { label: 'Kurta Pajama', gender: 'men', region: 'pk', cut: 'straight', neck: { y: 0.975, dip: 0.035 }, collar: 'ban', placket: 0.55,
                 bottom: -0.5, flare: 0.03, flarePow: 1, pleat: 0.004, pleats: 6, sway: 0, sleeves: { len: 0.62, r0: 0.078, r1: 0.06 },
                 trousers: { kind: 'slim' }, fabric: 'lawn', pattern: 'plain', color: 'royal' },
  m_waistcoat: { label: 'Waistcoat Suit', gender: 'men', region: 'pk', cut: 'straight', neck: { y: 0.975, dip: 0.035 }, collar: 'ban', placket: 0.6,
                 bottom: -0.56, flare: 0.03, flarePow: 1, pleat: 0.004, pleats: 6, sway: 0, sleeves: { len: 0.62, r0: 0.078, r1: 0.06 },
                 trousers: { kind: 'shalwar' }, vest: { color: '#6b1f2a', bottom: 0.08 }, fabric: 'lawn', pattern: 'plain', color: 'ivory' },
  m_shirt:     { label: 'Shirt & Jeans', gender: 'men', region: 'west', cut: 'straight', neck: { y: 0.975, dip: 0.04 }, collar: 'shirt', placket: 0.04,
                 bottom: 0.02, flare: 0, flarePow: 1, pleat: 0.002, pleats: 6, sway: 0, sleeves: { len: 0.62, r0: 0.078, r1: 0.06 },
                 trousers: { kind: 'jeans', color: '#3d5a80' }, fabric: 'linen', pattern: 'plain', color: 'sky' },
  m_dress:     { label: 'Dress Shirt & Trousers', gender: 'men', region: 'west', cut: 'straight', neck: { y: 0.975, dip: 0.04 }, collar: 'shirt', placket: 0.04,
                 bottom: 0.02, flare: 0, flarePow: 1, pleat: 0.002, pleats: 6, sway: 0, sleeves: { len: 0.62, r0: 0.078, r1: 0.06 },
                 trousers: { kind: 'jeans', color: '#22232b' }, fabric: 'crepe', pattern: 'plain', color: 'noir' },
  m_tee:       { label: 'T-shirt & Jeans', gender: 'men', region: 'west', cut: 'straight', neck: { y: 0.975, dip: 0.05 },
                 bottom: 0.03, flare: 0, flarePow: 1, pleat: 0.002, pleats: 6, sway: 0, sleeves: { len: 0.2, r0: 0.082, r1: 0.078 },
                 trousers: { kind: 'jeans', color: '#3d5a80' }, fabric: 'lawn', pattern: 'plain', color: 'ivory' },
};
export const ALL = { ...STYLES, ...MEN };
export const REGION_LABEL = { pk: 'Pakistani', uk: 'British', us: 'American', west: 'Western' };

// Unstitched fabric: the customer brings a fabric picture and chooses how it is stitched.
export const STITCH = {
  wearer: { men: 'Men\u2019s suit', women: 'Women\u2019s suit' },
  neck:   { gol: 'Gol gala', ban: 'Ban collar', shirt: 'Shirt collar', v: 'V-neck' },
  bottom: { shalwar: 'Shalwar', khuli: 'Khuli shalwar', kali: 'Kali wali shalwar', pajama: 'Pajama', trouser: 'Trouser' },
};
// drawing recipe for a stitched suit made from the customer's fabric
export function stitchedStyle({ wearer = 'men', neck = 'gol', bottom = 'shalwar' } = {}) {
  const dip = { gol: 0.07, ban: 0.03, shirt: 0.04, v: 0.15 }[neck] ?? 0.07;
  const base = wearer === 'men'
    ? { cut: 'straight', bottom: -0.56, flare: 0.03, sleeves: { len: 0.62, r0: 0.078, r1: 0.06 } }
    : { bottom: -0.5, flare: 0.07, sleeves: { len: 0.5, r0: 0.07, r1: 0.055 } };
  return {
    label: STITCH.wearer[wearer], gender: wearer, custom: true, ...base,
    neck: { y: 0.975, dip, shape: neck === 'v' ? 'v' : 'round' }, collar: neck === 'ban' || neck === 'shirt' ? neck : null,
    placket: neck === 'gol' || neck === 'v' ? null : 0.55,
    flarePow: 1.1, pleat: 0.004, pleats: 6, sway: 0, trousers: { kind: bottom },
  };
}

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
  white:     { label: 'White',     hex: '#f3f1ea' },
  charcoal:  { label: 'Charcoal',  hex: '#3a3d45' },
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
  const s = ALL[style];
  return { style, fabric: s.fabric, color: s.color, pattern: s.pattern, size };
};

export const LOOKBOOK = ['shalwar', 'gown', 'anarkali', 'tea', 'lehenga', 'jumpsuit', 'kurti', 'slip', 'sundress'].map((s) => lookFor(s));

// Real photos of each style on a model (free Unsplash licence, served from Unsplash's image CDN).
// `page` is the photo's Unsplash page; `pos` is the CSS object-position that keeps the outfit in frame.
const U = 'https://images.unsplash.com/';
export const PHOTOS = {
  shalwar:  { id: 'photo-1733470324488-d0e10d014d80', page: 'hbzeoDjfDAw', alt: 'Model in a yellow printed lawn shalwar kameez' },
  anarkali: { id: 'photo-1707576618343-26a1b377ca7a', page: 'x1h4Nw0CwfY', alt: 'Model in a red embroidered flared anarkali with dupatta' },
  kurti:    { id: 'photo-1733209589578-97136bee7d7a', page: 'OeYXZyM63cQ', alt: 'Model in a mint kurti with straight pants' },
  lehenga:  { id: 'photo-1760613130027-3959a3eb939c', page: 'W2wuIqypec', alt: 'Model in ornate red and gold bridal wear' },
  tea:      { id: 'photo-1511130558090-00af810c21b1', page: 'lSLq_xQdFNI', alt: 'Model in a floral tea dress' },
  ascot:    { id: 'photo-1631084675579-20db768ae08a', page: 'RPG_fve14_Y', alt: 'Model in a flowing green dress' },
  pleated:  { id: 'photo-1762343039457-3f8ae1f9b063', page: 'K8_I1OgK3lo', alt: 'Model in a black top and white pleated skirt' },
  gown:     { id: 'photo-1583039949165-96ee24b0d8de', page: 'cqgSaFgMSqg', alt: 'Model in a red evening gown' },
  slip:     { id: 'photo-1594739033447-80ab21e24b4c', page: 'GNd5gstTSg8', alt: 'Model in a black slip dress' },
  sundress: { id: 'photo-1777713272516-e7b2216fe15e', page: 'y40t2wpvmqU', alt: 'Model in a white sundress in a garden' },
  jumpsuit: { id: 'photo-1495385794356-15371f348c31', page: 'c5t_j1zlk1Y', alt: 'Model in a teal jumpsuit' },
  m_shalwar:   { id: 'photo-1734418040900-e964f84e8abb', page: 'WpE5DzEZ-e0', alt: 'Man in a white shalwar kameez' },
  m_kurta:     { id: 'photo-1770359993283-a2c2f386584e', page: 'sLRFg-VC2FY', alt: 'Man in a blue kurta and pajama' },
  m_waistcoat: { id: 'photo-1785651523544-b8ecbbfecebe', page: 'WRS_fX4YIMc', alt: 'Man in a kurta with a maroon waistcoat' },
  m_shirt:     { id: 'photo-1792007195205-dc9f0ba038e9', page: 'o86ZeQjjmDw', alt: 'Man in a light blue shirt and trousers' },
  m_dress:     { id: 'photo-1763610452422-a24873594a0b', page: 'hyy3Lrv5WdM', alt: 'Man in a black dress shirt and trousers' },
  m_tee:       { id: 'photo-1781106477318-b44ff46d7fdf', page: 'bfy9MidHYUY', alt: 'Man in a T-shirt and jeans' },
};
export const photoUrl = (style, w = 900) => `${U}${PHOTOS[style].id}?auto=format&fit=crop&crop=faces,center&w=${w}&h=${Math.round(w * 1.5)}&q=80`;
export const photoPage = (style) => `https://unsplash.com/photos/${PHOTOS[style].page}`;
