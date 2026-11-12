# Esha's work: Miraal virtual try-on (concept site)

A landing page and interactive demo for a virtual try-on app:

- 3D dress form you can dress in different styles, fabrics, colours and sizes (Three.js)
- Guided camera body scan: live precautions, voice guidance to turn front / side / back / side, and live measurements (MediaPipe Pose, runs in the browser)
- Privacy: the camera picture is never uploaded or kept, and it is deleted as soon as the scan ends. Only the numbers stay, on your own device.
- Optional local profile (stored in your browser only)

The product name is Miraal.

## Run locally

```
python -m http.server 5173
```

Then open http://localhost:5173 in Chrome.
