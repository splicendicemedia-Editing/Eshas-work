import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { STYLES, FABRICS, COLORS, SIZES, LOOKBOOK } from './catalog.js?v=5';

/* ------------------------------------------------------------------ helpers */
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const damp = (a, b, l, dt) => lerp(a, b, 1 - Math.exp(-l * dt));
const bump = (y, a, b) => { const t = (y - a) / (b - a); return t <= 0 || t >= 1 ? 0 : Math.sin(Math.PI * t) ** 2; };
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const WHITE = new THREE.Color(1, 1, 1);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ------------------------------------------------------- dress-form profile */
// [radius, height] of the tailor's dress form, hip base (y=0) to neck (y≈1.12)
const SIDE = [
  [0.27, -0.03], [0.31, 0.0], [0.345, 0.1], [0.36, 0.2], [0.35, 0.28], [0.315, 0.38],
  [0.272, 0.47], [0.262, 0.52], [0.28, 0.59], [0.32, 0.67], [0.335, 0.73], [0.325, 0.79],
  [0.30, 0.85], [0.255, 0.91], [0.18, 0.965], [0.10, 1.0], [0.078, 1.03], [0.075, 1.1], [0.085, 1.12],
];
const SIDE_PTS = new THREE.SplineCurve(SIDE.map(([r, y]) => new THREE.Vector2(r, y))).getSpacedPoints(150);

function bodyR(y) {
  const P = SIDE_PTS;
  if (y <= P[0].y) return P[0].x;
  if (y >= P[P.length - 1].y) return P[P.length - 1].x;
  let lo = 0, hi = P.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (P[m].y < y) lo = m; else hi = m; }
  const a = P[lo], b = P[hi];
  return lerp(a.x, b.x, (y - a.y) / (b.y - a.y || 1));
}
// Turns the round lathe into a human-like cross-section: shoulders, flatter depth, bust and seat.
function shapeXZ(x, y, z, o) {
  x *= 1 + 0.42 * bump(y, 0.8, 0.985);
  z *= 0.74;
  if (z > 0) z *= 1 + 0.11 * bump(y, 0.6, 0.82);
  else z *= 1 + 0.07 * bump(y, 0.02, 0.34);
  o.x = x; o.y = y; o.z = z;
  return o;
}
function surface(th, y, off, o) {
  const r = bodyR(y) + off;
  return shapeXZ(r * Math.sin(th), y, r * Math.cos(th), o);
}
const WAIST_Y = 0.515;
const R_WAIST = bodyR(WAIST_Y);
// below the widest hip point fabric falls straight instead of tucking back under the form
const HIP = SIDE_PTS.filter((p) => p.y < 0.4).reduce((a, p) => (p.x > a.x ? p : a));
const skirtBase = (y) => (y < HIP.y ? Math.max(bodyR(y), HIP.x) : bodyR(y));
const smax = (a, b, k) => (a + b + Math.sqrt((a - b) * (a - b) + k * k)) / 2;
function garmentBaseR(p, ease, y) {
  const s = clamp((WAIST_Y - y) / (WAIST_Y - p.bottom), 0, 1);
  return smax(skirtBase(y) + ease, R_WAIST + ease + p.flare * Math.pow(s, p.flarePow), 0.035 * Math.min(1, s * 6));
}
function fixSeam(geo, segs, rows) {
  const n = geo.attributes.normal;
  for (let j = 0; j < rows; j++) {
    const a = j, b = segs * rows + j;
    let x = n.getX(a) + n.getX(b), y = n.getY(a) + n.getY(b), z = n.getZ(a) + n.getZ(b);
    const l = Math.hypot(x, y, z) || 1; x /= l; y /= l; z /= l;
    n.setXYZ(a, x, y, z); n.setXYZ(b, x, y, z);
  }
  n.needsUpdate = true;
}

/* ------------------------------------------------------ procedural textures */
function makeWeave() {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#808080'; g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 256; i += 4) {
    g.fillStyle = `rgba(255,255,255,${0.12 + Math.random() * 0.12})`; g.fillRect(0, i, 256, 2);
    g.fillStyle = `rgba(0,0,0,${0.12 + Math.random() * 0.12})`; g.fillRect(i, 0, 2, 256);
  }
  const img = g.getImageData(0, 0, 256, 256);
  for (let k = 0; k < img.data.length; k += 4) {
    const n = (Math.random() - 0.5) * 34;
    img.data[k] += n; img.data[k + 1] += n; img.data[k + 2] += n;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
function makeDot() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.35, 'rgba(255,255,255,.5)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

/* ----------------------------------------------------------------- garment */
class Garment {
  constructor(parent, weave) {
    this.M = 144; this.R = 100;
    const { M, R } = this;
    const n = (M + 1) * R;
    this.pos = new Float32Array(n * 3);
    this.col = new Float32Array(n * 3).fill(1);
    const uv = new Float32Array(n * 2);
    for (let i = 0; i <= M; i++) for (let j = 0; j < R; j++) {
      const k = i * R + j; uv[k * 2] = i / M; uv[k * 2 + 1] = 1 - j / (R - 1);
    }
    const idx = [];
    for (let i = 0; i < M; i++) for (let j = 0; j < R - 1; j++) {
      const a = i * R + j, b = (i + 1) * R + j, c = (i + 1) * R + j + 1, d = i * R + j + 1;
      idx.push(a, d, b, b, d, c);
    }
    this.geo = new THREE.BufferGeometry();
    this.geo.setIndex(idx);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));

    const bumpTex = weave.clone(); bumpTex.repeat.set(40, 26); bumpTex.needsUpdate = true;
    this.plane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 100);
    this.mat = new THREE.MeshPhysicalMaterial({
      side: THREE.DoubleSide, vertexColors: true, clippingPlanes: [this.plane], clipShadows: true,
      bumpMap: bumpTex, envMapIntensity: 0.4, sheenColor: new THREE.Color(1, 1, 1),
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.castShadow = true; this.mesh.receiveShadow = true; this.mesh.frustumCulled = false;
    this.group = new THREE.Group(); this.group.add(this.mesh); this.group.visible = false;
    parent.add(this.group);

    this.look = null; this.p = null; this.straps = null;
    this.ease = 0.013; this.easeT = 0.013; this.strapEase = 0.013;
    this.color = new THREE.Color(); this.colorT = new THREE.Color();
    this.heatAmt = 0;
    this.tmp = { x: 0, y: 0, z: 0 };
  }
  setLook(look) {
    this.look = look;
    this.plane.constant = 100;
    if (!look) { this.group.visible = false; return; }
    this.group.visible = true;
    this.p = { ...STYLES[look.style] };
    const f = FABRICS[look.fabric];
    Object.assign(this.mat, { roughness: f.roughness, sheen: f.sheen, sheenRoughness: f.sheenRoughness, bumpScale: f.bump });
    this.colorT.set(COLORS[look.color].hex); this.color.copy(this.colorT);
    this.ease = this.easeT = SIZES[look.size].ease;
    this.buildStraps();
  }
  retarget(look) {
    this.look = look;
    this.colorT.set(COLORS[look.color].hex);
    this.easeT = SIZES[look.size].ease;
  }
  buildStraps() {
    if (this.straps) { this.straps.children.forEach((m) => m.geometry.dispose()); this.group.remove(this.straps); this.straps = null; }
    if (!this.p.straps) return;
    this.strapEase = this.ease;
    this.straps = new THREE.Group();
    const o = {};
    const path = [[0.42, this.p.top - 0.004], [0.5, 0.85], [0.78, 0.93], [Math.PI / 2, 0.962], [Math.PI - 0.78, 0.93], [Math.PI - 0.5, 0.85], [Math.PI - 0.42, this.p.top - 0.004]];
    for (const sgn of [1, -1]) {
      const pts = path.map(([th, y]) => { surface(sgn * th, y, this.ease + 0.007, o); return new THREE.Vector3(o.x, o.y, o.z); });
      const g = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 48, 0.0055, 6, false);
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 3).fill(1), 3));
      const m = new THREE.Mesh(g, this.mat); m.castShadow = true;
      this.straps.add(m);
    }
    this.group.add(this.straps);
  }
  update(time, dt, heatT) {
    if (!this.group.visible || !this.look) return;
    const { M, R, pos, col, p, tmp } = this;
    this.ease = damp(this.ease, this.easeT, 6, dt);
    if (this.straps && Math.abs(this.ease - this.strapEase) > 0.0015) this.buildStraps();
    this.color.lerp(this.colorT, 1 - Math.exp(-5 * dt));
    this.heatAmt = damp(this.heatAmt, heatT, 6, dt);
    this.mat.color.copy(this.color).lerp(WHITE, this.heatAmt * 0.9);
    this.mat.sheenColor.copy(this.color).lerp(WHITE, FABRICS[this.look.fabric].sheenMix);

    const ease = this.ease, heat = this.heatAmt;
    let k = 0;
    for (let i = 0; i <= M; i++) {
      const th = (i / M) * Math.PI * 2;
      const sn = Math.sin(th), cs = Math.cos(th);
      for (let j = 0; j < R; j++) {
        const v = j / (R - 1);
        let y = lerp(p.top, p.bottom, v);
        const br = skirtBase(y);
        const s = clamp((WAIST_Y - y) / (WAIST_Y - p.bottom), 0, 1);
        let r = smax(br + ease, R_WAIST + ease + p.flare * Math.pow(s, p.flarePow), 0.035 * Math.min(1, s * 6));
        const baseEase = r - br - 0.004 * bump(y, 0.62, 0.8) - 0.003 * bump(y, 0.1, 0.3);
        const fold = s > 0 ? Math.pow(s, 1.15) : 0;
        const d = p.pleat * fold * (Math.sin(th * p.pleats) * 0.65 + Math.sin(th * p.pleats * 0.47 + 1.3) * 0.35)
          + 0.035 * fold * fold * Math.sin(th * 3 - time * 1.2 + y * 3) * p.sway
          + 0.012 * fold * Math.sin(th * 7 + time * 0.8) * p.sway;
        r *= 1 + d;
        y += 0.018 * Math.pow(v, 4) * Math.sin(th * 5 + time * 0.9) * p.sway;
        shapeXZ(r * sn, y, r * cs, tmp);
        pos[k * 3] = tmp.x; pos[k * 3 + 1] = tmp.y; pos[k * 3 + 2] = tmp.z;

        // fit heatmap: red = tight, green = ideal, blue = loose
        if (heat > 0.001) {
          let cr, cg, cb;
          if (baseEase < 0.013) { const t = clamp((baseEase - 0.002) / 0.011, 0, 1); cr = lerp(1, 0.25, t); cg = lerp(0.12, 0.95, t); cb = lerp(0.18, 0.5, t); }
          else { const t = clamp((baseEase - 0.013) / 0.02, 0, 1); cr = lerp(0.25, 0.25, t); cg = lerp(0.95, 0.45, t); cb = lerp(0.5, 1, t); }
          col[k * 3] = lerp(1, cr, heat); col[k * 3 + 1] = lerp(1, cg, heat); col[k * 3 + 2] = lerp(1, cb, heat);
        } else if (col[k * 3] !== 1) { col[k * 3] = col[k * 3 + 1] = col[k * 3 + 2] = 1; }
        k++;
      }
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
    this.geo.computeVertexNormals();
    fixSeam(this.geo, M, R);
  }
  radiusAt(y) {
    if (!this.look || y > this.p.top + 0.01 || y < this.p.bottom - 0.01) return 0;
    return garmentBaseR(this.p, this.ease, y) * (1 + this.p.pleat * 0.6);
  }
}

/* ------------------------------------------------------------------- scene */
export function createScene({ canvas, labelsEl, onReady, studioLook }) {
  const isNarrow = () => innerWidth / innerHeight < 1.0 || innerWidth < 820;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  if (!renderer.getContext()) throw new Error('WebGL unavailable');
  const DPR = Math.min(window.devicePixelRatio || 1, innerWidth < 820 ? 1.5 : 2);
  renderer.setPixelRatio(DPR);
  renderer.setSize(innerWidth, innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.92;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.localClippingEnabled = true;

  const scene = new THREE.Scene();
  const BG = new THREE.Color('#0b0a0f');
  scene.background = BG;
  scene.fog = new THREE.Fog(BG, 7, 16);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;

  const camera = new THREE.PerspectiveCamera(32, innerWidth / innerHeight, 0.1, 60);
  camera.position.set(0, 0.25, 5.6);

  /* lights */
  scene.add(new THREE.HemisphereLight(0xc4b8ff, 0x1a1410, 0.45));
  const key = new THREE.SpotLight(0xffe4c4, 42, 0, Math.PI / 6.5, 0.7, 2);
  key.position.set(-2.4, 3.6, 3.4);
  key.castShadow = true;
  key.shadow.mapSize.set(innerWidth < 820 ? 1024 : 2048, innerWidth < 820 ? 1024 : 2048);
  key.shadow.bias = -0.0004; key.shadow.normalBias = 0.02;
  key.shadow.camera.near = 1; key.shadow.camera.far = 12;
  scene.add(key, key.target);
  const rimV = new THREE.DirectionalLight(0x8f7bff, 2.6); rimV.position.set(2.8, 1.6, -3); scene.add(rimV);
  const rimW = new THREE.DirectionalLight(0xffb38a, 1.8); rimW.position.set(-3, 0.6, -2.6); scene.add(rimW);
  const fill = new THREE.DirectionalLight(0xffffff, 0.35); fill.position.set(0.5, 1, 5); scene.add(fill);

  /* backdrop glow */
  const glowMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uC1: { value: new THREE.Color('#4b3cc4') }, uC2: { value: new THREE.Color('#b9744a') }, uT: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }',
    fragmentShader: `varying vec2 vUv; uniform vec3 uC1; uniform vec3 uC2; uniform float uT;
      void main(){ vec2 p=vUv-.5; float d=length(p*vec2(1.,1.25)); float a=smoothstep(.5,.0,d);
      vec3 c=mix(uC1,uC2, smoothstep(-.35,.45,p.x+.18*sin(uT*.25)+.1*p.y)); gl_FragColor=vec4(c, a*a*.5); }`,
  });
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(10, 7.5), glowMat);
  glow.position.set(0, 0.2, -3.4);
  scene.add(glow);

  /* rig: dress form + stand + platform */
  const rig = new THREE.Group();
  scene.add(rig);
  const weave = makeWeave();

  const lathePts = [new THREE.Vector2(0, -0.03), ...SIDE_PTS, new THREE.Vector2(0, 1.125)];
  const BODY_SEGS = 128;
  const bodyGeo = new THREE.LatheGeometry(lathePts, BODY_SEGS);
  {
    const p = bodyGeo.attributes.position; const o = {};
    for (let k = 0; k < p.count; k++) { shapeXZ(p.getX(k), p.getY(k), p.getZ(k), o); p.setXYZ(k, o.x, o.y, o.z); }
    bodyGeo.computeVertexNormals(); fixSeam(bodyGeo, BODY_SEGS, lathePts.length);
  }
  const bodyBump = weave.clone(); bodyBump.repeat.set(56, 34); bodyBump.needsUpdate = true;
  const bodyMat = new THREE.MeshPhysicalMaterial({
    color: '#cbc1b2', roughness: 0.82, sheen: 0.45, sheenRoughness: 0.6, sheenColor: new THREE.Color('#fff2e2'),
    bumpMap: bodyBump, bumpScale: 0.8, envMapIntensity: 0.3,
  });
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.castShadow = true; body.receiveShadow = true;
  rig.add(body);

  // princess seams like a real tailor's dummy
  const seamMat = new THREE.MeshStandardMaterial({ color: '#6b5a48', roughness: 0.9 });
  for (const th of [0.42, -0.42, Math.PI - 0.5, -(Math.PI - 0.5), Math.PI / 2, -Math.PI / 2]) {
    const pts = []; const o = {};
    for (let y = 0.0; y <= 0.95; y += 0.05) { surface(th, y, 0.0015, o); pts.push(new THREE.Vector3(o.x, o.y, o.z)); }
    rig.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 40, 0.0022, 5, false), seamMat));
  }

  const brass = new THREE.MeshPhysicalMaterial({ color: '#c8a165', metalness: 1, roughness: 0.28, envMapIntensity: 1.1 });
  const darkMetal = new THREE.MeshPhysicalMaterial({ color: '#17151b', metalness: 0.6, roughness: 0.35, clearcoat: 0.6, envMapIntensity: 0.7 });
  const addMesh = (geo, mat, y, extra) => { const m = new THREE.Mesh(geo, mat); m.position.y = y; m.castShadow = true; m.receiveShadow = true; if (extra) extra(m); rig.add(m); return m; };
  addMesh(new THREE.CylinderGeometry(0.088, 0.088, 0.022, 48), brass, 1.122);
  addMesh(new THREE.SphereGeometry(0.03, 24, 16), brass, 1.155);
  addMesh(new THREE.CylinderGeometry(0.262, 0.262, 0.012, 64), brass, -0.034, (m) => (m.scale.z = 0.76));
  addMesh(new THREE.CylinderGeometry(0.016, 0.016, 1.12, 24), brass, -0.6);
  addMesh(new THREE.CylinderGeometry(0.032, 0.032, 0.07, 32), brass, -0.55);
  addMesh(new THREE.CylinderGeometry(0.24, 0.28, 0.045, 64), darkMetal, -1.15 + 0.0225);

  const platMat = new THREE.MeshPhysicalMaterial({ color: '#0a090d', roughness: 0.3, metalness: 0.2, clearcoat: 1, clearcoatRoughness: 0.2, envMapIntensity: 0.18 });
  const plat = new THREE.Mesh(new THREE.CylinderGeometry(1.25, 1.3, 0.06, 120), platMat);
  plat.position.y = -1.18; plat.receiveShadow = true; rig.add(plat);
  const ringGeo = new THREE.TorusGeometry(1, 0.006, 6, 220);
  const edge = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color('#e2c08d').multiplyScalar(2.2), toneMapped: false }));
  edge.rotation.x = Math.PI / 2; edge.scale.set(1.255, 1.255, 1); edge.position.y = -1.15; rig.add(edge);
  const inner = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color('#9d8cff').multiplyScalar(0.9), toneMapped: false, transparent: true, opacity: 0.6 }));
  inner.rotation.x = Math.PI / 2; inner.scale.set(0.82, 0.82, 0.6); inner.position.y = -1.149; rig.add(inner);

  /* scan visuals */
  const haloMat = (hex) => new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { uO: { value: 0 }, uC: { value: new THREE.Color(hex) } },
    vertexShader: 'varying float vR; void main(){ vR=length(position.xy); gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }',
    fragmentShader: 'varying float vR; uniform float uO; uniform vec3 uC; void main(){ float a=smoothstep(1.55,1.0,vR)*smoothstep(0.97,1.01,vR); gl_FragColor=vec4(uC*1.6, a*.55*uO); }',
  });
  const makeScanRing = (hex, mult) => {
    const g = new THREE.Group();
    const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(mult), toneMapped: false, transparent: true, opacity: 0 }));
    const halo = new THREE.Mesh(new THREE.RingGeometry(0.97, 1.6, 120), haloMat(hex));
    ring.rotation.x = halo.rotation.x = -Math.PI / 2;
    g.add(ring, halo); g.userData = { ring, halo };
    rig.add(g);
    g.visible = false;
    return g;
  };
  const scanRing = makeScanRing('#a99bff', 3);
  const sweepRing = makeScanRing('#f1d3a3', 3.2);
  const placeRing = (g, y, r, o) => {
    const rx = r * (1 + 0.42 * bump(y, 0.8, 0.985)) + 0.012;
    const rz = r * 0.74 * (1 + 0.06 * bump(y, 0.6, 0.82)) + 0.012;
    g.position.y = y;
    g.userData.ring.scale.set(rx, rz, 1); g.userData.halo.scale.set(rx, rz, 1);
    g.userData.ring.material.opacity = o; g.userData.halo.material.uniforms.uO.value = o;
    g.visible = o > 0.003;
  };

  // body point-cloud that lights up under the scanner
  const ptsGeo = new THREE.LatheGeometry([new THREE.Vector2(0.001, -0.02), ...new THREE.SplineCurve(SIDE.map(([r, y]) => new THREE.Vector2(r, y))).getSpacedPoints(70)], 84);
  {
    const p = ptsGeo.attributes.position; const o = {};
    for (let k = 0; k < p.count; k++) { const x = p.getX(k), y = p.getY(k), z = p.getZ(k); const l = Math.hypot(x, z) || 1; shapeXZ(x + (x / l) * 0.006, y, z + (z / l) * 0.006, o); p.setXYZ(k, o.x, o.y, o.z); }
  }
  const scanPtsMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uScanY: { value: 0.5 }, uO: { value: 0 }, uC: { value: new THREE.Color('#b3a6ff') }, uSize: { value: 18 * DPR } },
    vertexShader: `uniform float uScanY; uniform float uO; uniform float uSize; varying float vA;
      void main(){ vec4 wp=modelMatrix*vec4(position,1.); float d=wp.y-uScanY; float band=exp(-d*d/.0016);
      vA=(band*.9+.035)*uO; vec4 mv=viewMatrix*wp; gl_PointSize=uSize*(1.+band*1.6)/-mv.z; gl_Position=projectionMatrix*mv; }`,
    fragmentShader: 'varying float vA; uniform vec3 uC; void main(){ vec2 c=gl_PointCoord-.5; float m=smoothstep(.5,.0,length(c)); gl_FragColor=vec4(uC*1.3, m*vA); }',
  });
  const scanPts = new THREE.Points(ptsGeo, scanPtsMat);
  scanPts.visible = false;
  rig.add(scanPts);

  // dashed measurement loops at bust / waist / hips
  const MEAS_Y = { bust: 0.73, waist: WAIST_Y, hips: 0.2 };
  const measLoops = Object.values(MEAS_Y).map((y) => {
    const o = {}; const pts = [];
    for (let i = 0; i <= 128; i++) { surface((i / 128) * Math.PI * 2, y, 0.007, o); pts.push(new THREE.Vector3(o.x, o.y, o.z)); }
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineDashedMaterial({ color: new THREE.Color('#f1d3a3').multiplyScalar(2.4), dashSize: 0.022, gapSize: 0.014, transparent: true, opacity: 0, toneMapped: false }));
    line.computeLineDistances();
    rig.add(line);
    return line;
  });

  /* dust */
  const DUST = 260;
  const dustPos = new Float32Array(DUST * 3);
  for (let i = 0; i < DUST; i++) { dustPos[i * 3] = (Math.random() - 0.5) * 9; dustPos[i * 3 + 1] = Math.random() * 4.2 - 1.6; dustPos[i * 3 + 2] = Math.random() * 5 - 3.2; }
  const dustGeo = new THREE.BufferGeometry(); dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
  const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({ size: 0.022, map: makeDot(), color: '#e8cfa6', transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending }));
  scene.add(dust);

  /* garments */
  let cur = new Garment(rig, weave);
  let nxt = new Garment(rig, weave);
  let sweep = null;
  let pending;
  const sameKind = (a, b) => a && b && a.style === b.style && a.fabric === b.fabric;
  function wear(look) { pending = look; if (!sweep) startSweep(); }
  function startSweep() {
    if (pending === undefined) return;
    const look = pending; pending = undefined;
    if (!look && !cur.look) return;
    if (sameKind(look, cur.look)) { cur.retarget(look); return; }
    nxt.setLook(look);
    const tops = [], bots = [];
    for (const g of [cur, nxt]) if (g.look) { tops.push(g.p.top + (g.p.straps ? 0.2 : 0)); bots.push(g.p.bottom); }
    sweep = { t: 0, from: Math.max(...tops) + 0.04, to: Math.min(...bots) - 0.06, dur: reduceMotion ? 0.5 : 1.35 };
    cur.plane.normal.set(0, -1, 0);
    nxt.plane.normal.set(0, 1, 0);
  }

  /* labels (HTML anchored to 3D points) */
  const Q = Math.PI / 2;
  const LABEL_DEFS = {
    hero: [
      { fixed: [0.5, 0.74, 0], side: 'right', html: '<small>AI size match</small><b>M · EU 38</b><em>96% fit confidence</em>' },
      { fixed: [0.6, -0.55, 0], side: 'right', html: '<small>Live fabric physics</small><b>Crushed velvet</b>' },
    ],
    scan: [
      { y: MEAS_Y.bust, off: 0.008, side: 'right', html: '<small>Bust</small><b>86.4 cm</b>' },
      { y: MEAS_Y.waist, off: 0.008, side: 'right', html: '<small>Waist</small><b>68.2 cm</b>' },
      { y: MEAS_Y.hips, off: 0.008, side: 'right', html: '<small>Hips</small><b>94.0 cm</b>' },
    ],
    fit: [
      { y: MEAS_Y.bust, off: 0.03, side: 'right', html: '<small>Bust</small><b>Perfect</b><em>+0.8 cm ease</em>' },
      { y: MEAS_Y.waist, off: 0.03, side: 'right', html: '<small>Waist</small><b>Comfortable</b><em>+1.5 cm ease</em>' },
      { y: 0.08, off: 0.05, side: 'right', html: '<small>Hips</small><b>Relaxed drape</b><em>bias-cut skirt</em>' },
    ],
  };
  const labels = [];
  for (const [group, defs] of Object.entries(LABEL_DEFS)) {
    defs.forEach((d, i) => {
      const el = document.createElement('div');
      el.className = `lbl ${d.side}`;
      el.style.setProperty('--d', `${i * 0.12}s`);
      el.innerHTML = `<i class="dot"></i><span class="ln"></span><div class="tag">${d.html}</div>`;
      labelsEl.appendChild(el);
      labels.push({ group, def: d, el });
    });
  }

  /* states */
  const HERO_LOOK = { style: 'gown', fabric: 'velvet', color: 'bordeaux', size: 'M' };
  const FIT_LOOK = { style: 'slip', fabric: 'silk', color: 'champagne', size: 'M' };
  const LABEL_ANGLE = 0.35;
  const STATES = {
    hero:   { x: 0.95, spin: 0.22, angle: null, scan: 0, labels: 'hero', look: () => HERO_LOOK, camZ: 5.6, camY: 0.2, lookY: -0.1, mLookY: -0.75 },
    scan:   { mX: -0.34, x: 0.62, spin: 0, angle: LABEL_ANGLE, scan: 1, labels: 'scan', look: () => null, camZ: 5.1, camY: 0.4, lookY: 0.05, mLookY: -0.55 },
    fit:    { mX: -0.34, x: 0.62, spin: 0, angle: LABEL_ANGLE, scan: 0, labels: 'fit', look: () => FIT_LOOK, camZ: 5.1, camY: 0.4, lookY: 0.05, mLookY: -0.55 },
    style:  { x: -0.9, spin: 0.45, angle: null, scan: 0, labels: null, look: 'cycle', camZ: 5.8, camY: 0.2, lookY: -0.1, mLookY: -0.75 },
    studio: { x: 0.85, spin: 0.1, angle: null, scan: 0, labels: null, look: () => studio, camZ: 5.4, camY: 0.2, lookY: -0.05, mLookY: -0.55 },
  };
  let studio = studioLook || FIT_LOOK;
  let stateName = 'hero';
  let heat = false;
  let cycleIdx = 0, cycleAt = 0;
  const live = { x: STATES.hero.x * xFactor(), camZ: STATES.hero.camZ, camY: STATES.hero.camY, lookY: STATES.hero.lookY, scan: 0, labels: 0 };

  function xFactor() { return isNarrow() ? 0 : clamp(camera.aspect / 1.7, 0.7, 1.15); }
  function setState(name) {
    if (!STATES[name] || name === stateName) return;
    stateName = name;
    const s = STATES[name];
    if (s.look === 'cycle') { cycleAt = 0; } else wear(s.look());
    labels.forEach((l) => l.el.classList.toggle('show', l.group === s.labels));
  }

  /* post-processing */
  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(DPR);
  composer.setSize(innerWidth, innerHeight);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.5, 0.5, 0.97);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  function resize() {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight, false);
    composer.setSize(innerWidth, innerHeight);
  }
  addEventListener('resize', resize);

  /* input */
  const mouse = { x: 0, y: 0, sx: 0, sy: 0 };
  addEventListener('pointermove', (e) => { mouse.x = (e.clientX / innerWidth) * 2 - 1; mouse.y = (e.clientY / innerHeight) * 2 - 1; }, { passive: true });
  let dragVel = 0;
  let active = true;

  /* first state */
  cur.setLook(HERO_LOOK);
  labels.forEach((l) => l.el.classList.toggle('show', l.group === 'hero'));

  /* loop */
  const clock = new THREE.Clock();
  const v3 = new THREE.Vector3();
  const o = {};
  let readySent = false;
  let time = 0;
  function loop() {
    requestAnimationFrame(loop);
    const dt = Math.min(clock.getDelta(), 0.05);
    if (!active) return;
    time += dt;
    const s = STATES[stateName];
    const narrow = isNarrow();

    // camera + rig choreography
    live.x = damp(live.x, narrow ? s.mX || 0 : s.x * xFactor(), 2.6, dt);
    live.camZ = damp(live.camZ, s.camZ + (narrow ? 2.7 : Math.max(0, 1.75 - camera.aspect) * 2.2), 2.2, dt);
    live.camY = damp(live.camY, s.camY, 2.2, dt);
    live.lookY = damp(live.lookY, narrow ? s.mLookY : s.lookY, 2.2, dt);
    mouse.sx = damp(mouse.sx, mouse.x, 3, dt); mouse.sy = damp(mouse.sy, mouse.y, 3, dt);
    rig.position.x = live.x;
    camera.position.set(mouse.sx * 0.18, live.camY - mouse.sy * 0.1, live.camZ);
    camera.lookAt(0, live.lookY, 0);
    key.target.position.set(live.x, 0, 0);
    glow.position.x = live.x * 0.6;
    glowMat.uniforms.uT.value = time;

    if (s.angle === null) rig.rotation.y += s.spin * dt * (reduceMotion ? 0.3 : 1);
    else {
      const d = Math.atan2(Math.sin(s.angle - rig.rotation.y), Math.cos(s.angle - rig.rotation.y));
      rig.rotation.y += d * (1 - Math.exp(-3 * dt));
    }
    rig.rotation.y += dragVel;
    dragVel *= Math.exp(-4 * dt);

    // look-book cycling
    if (s.look === 'cycle' && time > cycleAt) {
      cycleAt = time + 3.2;
      wear(LOOKBOOK[cycleIdx++ % LOOKBOOK.length]);
    }

    // outfit sweep transition
    if (sweep) {
      sweep.t += dt / sweep.dur;
      const k = easeInOut(clamp(sweep.t, 0, 1));
      const h = lerp(sweep.from, sweep.to, k);
      cur.plane.constant = h;
      nxt.plane.constant = -h;
      let rr = Math.max(cur.radiusAt(h), nxt.radiusAt(h));
      if (!rr) rr = h > -0.03 && h < 1.12 ? bodyR(h) + 0.01 : 0.05;
      placeRing(sweepRing, h, rr, Math.sin(Math.PI * clamp(sweep.t, 0, 1)) ** 0.5);
      if (sweep.t >= 1) {
        const old = cur; cur = nxt; nxt = old;
        old.setLook(null);
        cur.plane.normal.set(0, -1, 0); cur.plane.constant = 100;
        sweep = null; placeRing(sweepRing, 0, 0.3, 0);
        startSweep();
      }
    }
    const heatT = heat && stateName === 'studio' ? 1 : 0;
    cur.update(time, dt, heatT);
    if (sweep) nxt.update(time, dt, heatT);

    // body scan
    live.scan = damp(live.scan, s.scan, 3, dt);
    const scanY = 0.5 + 0.56 * Math.sin(time * 1.05);
    scanPtsMat.uniforms.uScanY.value = scanY;
    scanPtsMat.uniforms.uO.value = live.scan;
    scanPts.visible = live.scan > 0.01;
    placeRing(scanRing, scanY, bodyR(scanY) + 0.01, live.scan);
    measLoops.forEach((l) => { l.material.opacity = live.scan * 0.9; l.visible = live.scan > 0.01; });

    // dust drift
    const dp = dustGeo.attributes.position.array;
    for (let i = 0; i < DUST; i++) { dp[i * 3 + 1] += dt * (0.03 + (i % 5) * 0.006); if (dp[i * 3 + 1] > 2.6) dp[i * 3 + 1] = -1.6; }
    dustGeo.attributes.position.needsUpdate = true;
    dust.rotation.y = time * 0.01;

    composer.render();

    // project labels
    for (const l of labels) {
      if (l.group !== s.labels && !l.el.classList.contains('show')) continue;
      const d = l.def;
      if (d.fixed) v3.set(rig.position.x + d.fixed[0], d.fixed[1], d.fixed[2]);
      else { surface(Q - LABEL_ANGLE, d.y, d.off, o); v3.set(o.x, o.y, o.z); rig.localToWorld(v3); }
      v3.project(camera);
      const px = (v3.x * 0.5 + 0.5) * innerWidth, py = (-v3.y * 0.5 + 0.5) * innerHeight;
      l.el.style.transform = `translate(${px.toFixed(1)}px, ${py.toFixed(1)}px) translate(${d.side === 'left' ? '-100%' : '0'}, -50%)`;
    }

    if (!readySent) { readySent = true; onReady && onReady(); }
  }
  requestAnimationFrame(loop);

  return {
    setState,
    setStudioLook(look) { studio = { ...look }; if (stateName === 'studio') wear(studio); },
    setHeatmap(on) { heat = !!on; },
    drag(dx) { dragVel += dx * 0.0009; },
    setActive(on) { active = !!on; if (on) clock.getDelta(); },
  };
}
