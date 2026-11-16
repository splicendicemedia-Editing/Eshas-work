// Stores that use Miraal.
// To add a store: give it a short id (small letters, numbers and dashes), put its fabric photos in
// stores/<id>/, list them here, add the same id to STORES in server/tryon-worker.js (so its try-ons
// are counted), make its counter poster QR code (tools/make_qr.py), and send the store its link:
//   https://splicendicemedia-editing.github.io/Eshas-work/?store=<id>
// whatsapp: the store's number with country code and no + or spaces (for example 923001234567).
// If a store has no WhatsApp, email is used for the "Buy this fabric" button instead.

export const SITE_URL = 'https://splicendicemedia-editing.github.io/Eshas-work/';

export const STORES = {
  demo: {
    name: 'Miraal Demo Fabrics',
    city: 'Lahore',
    whatsapp: '',
    email: 'info@sndautomations.co',
    fabrics: [
      { file: 'indigo-block.jpg', name: 'Indigo block print' },
      { file: 'rose-lawn.jpg', name: 'Rose lawn print' },
      { file: 'maroon-stripe.jpg', name: 'Maroon with gold stripe' },
    ],
  },
};

const ID = /^[a-z0-9-]{2,30}$/;

// the store whose link the shopper opened, or null
export function currentStore() {
  let id = '';
  try { id = new URLSearchParams(location.search).get('store') || ''; } catch { id = ''; }
  id = id.toLowerCase();
  if (!ID.test(id) || !Object.prototype.hasOwnProperty.call(STORES, id)) return null;
  const s = STORES[id];
  return { id, ...s, fabrics: s.fabrics.map((f) => ({ ...f, url: `stores/${id}/${f.file}` })) };
}

export const storeLink = (id) => `${SITE_URL}?store=${encodeURIComponent(id)}`;

// where the "Buy this fabric" button goes: the store's WhatsApp, or an email
export function buyLink(s, text) {
  const num = String(s.whatsapp || '').replace(/\D/g, '');
  if (num.length >= 10) return `https://wa.me/${num}?text=${encodeURIComponent(text)}`;
  if (s.email) return `mailto:${s.email}?subject=${encodeURIComponent(`Fabric from ${s.name}`)}&body=${encodeURIComponent(text)}`;
  return '';
}
