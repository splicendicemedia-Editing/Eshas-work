// Counter poster for a store: poster.html?store=<id>
// Shows a printable poster with the store's QR code, and a ready message the store can send its customers.
import { currentStore, storeLink } from './stores.js?v=31';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const app = document.getElementById('app');
const shop = currentStore();

if (!shop) {
  app.innerHTML = '<div class="missing"><h1>Store not found</h1><p>Open this page from the link Miraal sent you, for example poster.html?store=your-store.</p></div>';
} else {
  const link = storeLink(shop.id);
  const message = `Assalam o Alaikum! You can now see our fabrics stitched on you before you buy. Open this link, pick a fabric, choose the stitching and take a photo. You will see the suit on yourself in about a minute: ${link}`;
  document.title = `Counter poster · ${shop.name}`;
  app.innerHTML = `
    <div class="tools">
      <h1>Your Miraal counter poster</h1>
      <p>Print it and put it where customers look at fabric. Below the poster is a message you can send customers on WhatsApp.</p>
      <div class="row"><button type="button" id="print">Print poster</button></div>
      <p><b>Message for your customers</b></p>
      <textarea id="msg" readonly>${esc(message)}</textarea>
      <div class="row"><button type="button" class="ghost" id="copy">Copy message</button><button type="button" class="ghost" id="wa">Send on WhatsApp</button></div>
    </div>
    <div class="sheet">
      <small>${esc(shop.name)}</small>
      <h2>See our fabric stitched, on you.</h2>
      <img src="stores/${esc(shop.id)}/qr.svg" alt="QR code for ${esc(link)}" width="320" height="320">
      <p class="scan">Scan with your phone camera</p>
      <ol>
        <li><b>1</b><span>Pick one of our fabrics</span></li>
        <li><b>2</b><span>Choose the stitching</span></li>
        <li><b>3</b><span>Take a photo and see the suit on you in about a minute</span></li>
      </ol>
      <p class="link">${esc(link)}</p>
      <p class="foot">Free for customers · Miraal</p>
    </div>`;
  document.getElementById('print').addEventListener('click', () => window.print());
  document.getElementById('copy').addEventListener('click', async (e) => {
    const b = e.currentTarget;
    try { await navigator.clipboard.writeText(message); b.textContent = 'Copied'; }
    catch { const t = document.getElementById('msg'); t.focus(); t.select(); b.textContent = 'Press copy on your phone'; }
    setTimeout(() => { b.textContent = 'Copy message'; }, 2500);
  });
  document.getElementById('wa').addEventListener('click', () => window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, '_blank', 'noopener'));
}
