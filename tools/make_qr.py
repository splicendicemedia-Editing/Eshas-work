"""Make the counter-poster QR code for every store in stores.js.

    python tools/make_qr.py            (needs: pip install segno==1.6.6)

Writes stores/<id>/qr.svg, pointing at the store's own Miraal link.
"""
import io
import os
import re
import sys

import segno

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

src = io.open(os.path.join(ROOT, 'stores.js'), encoding='utf-8').read()
site = re.search(r"SITE_URL = '([^']+)'", src).group(1)
block = src[src.index('export const STORES = {'):]
ids = re.findall(r'^  ([a-z0-9-]{2,30}): \{', block, flags=re.M)
if not ids:
    sys.exit('no stores found in stores.js')
for sid in ids:
    url = '%s?store=%s' % (site, sid)
    folder = os.path.join(ROOT, 'stores', sid)
    os.makedirs(folder, exist_ok=True)
    qr = segno.make(url, error='m', micro=False)
    qr.save(os.path.join(folder, 'qr.svg'), scale=10, border=2, dark='#1a1410', light='#ffffff', xmldecl=False, svgns=True)
    print('%s -> %s (version %s)' % (sid, url, qr.version))
