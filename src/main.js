import {
  Color,
  DirectionalLight,
  HemisphereLight,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  WebGLRenderer,
} from 'three';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { createAxes } from './axes.js';
import { createCameraRig } from './camera.js';
import { createGizmo } from './gizmo.js';
import { loadFly } from './loadFly.js';
import { createPicking } from './picking.js';
import { initUI } from './ui.js';

const status = document.getElementById('status');

const renderer = new WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = SRGBColorSpace;
// Axis labels: HTML over the canvas, positioned each frame from their 3D anchors.
const labelRenderer = new CSS2DRenderer();
labelRenderer.domElement.className = 'label-layer';
document.getElementById('viewer').append(renderer.domElement, labelRenderer.domElement);

const scene = new Scene();
scene.background = new Color(getComputedStyle(document.body).getPropertyValue('--bg').trim());

// Millimetre scene: near 0.01 mm keeps close-ups from clipping, far 100 mm keeps depth precision.
const camera = new PerspectiveCamera(35, 1, 0.01, 100);
scene.add(camera);

scene.add(new HemisphereLight(0xffffff, 0x50555c, 1.6));
// Key light rides with the camera, so the fly is always lit from the viewer's side.
const keyLight = new DirectionalLight(0xffffff, 1.8);
keyLight.position.set(0.5, 1, 0.5);
keyLight.target.position.set(0, 0, -1);
camera.add(keyLight, keyLight.target);

let rig = null;

// Render on demand: drawing every frame keeps the main thread busy for nothing, and is
// very costly where WebGL runs on the CPU (e.g. headless Chromium in Lighthouse).
let needsRender = true;
const requestRender = () => {
  needsRender = true;
};

function resize() {
  const { clientWidth: w, clientHeight: h } = renderer.domElement.parentElement;
  renderer.setSize(w, h);
  labelRenderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  rig?.resize();
  requestRender();
}
window.addEventListener('resize', resize);
resize();

try {
  const base = import.meta.env.BASE_URL;
  const [{ flyRoot, box }, meta] = await Promise.all([
    loadFly(`${base}fly.glb`),
    fetch(`${base}fly.meta.json`).then((r) => {
      if (!r.ok) throw new Error(`fly.meta.json: HTTP ${r.status}`);
      return r.json();
    }),
  ]);
  scene.add(flyRoot);
  const axes = createAxes(flyRoot, meta);

  const picking = createPicking({
    camera,
    domElement: renderer.domElement,
    flyRoot,
    axes,
    readout: document.getElementById('readout'),
  });

  let onCameraChange = () => {};
  rig = createCameraRig({
    camera,
    domElement: renderer.domElement,
    flyRoot,
    box,
    bodyLength: meta.bodyLength,
    onChange: () => {
      requestRender();
      picking.invalidate();
      onCameraChange();
    },
  });
  ({ onCameraChange } = initUI({
    rig,
    axes,
    onAxesChange: () => {
      requestRender();
      picking.invalidate();
    },
  }));

  const gizmo = createGizmo({
    renderer,
    camera,
    flyRoot,
    element: document.getElementById('gizmo'),
    onFace: (preset) => rig.viewPreset(preset),
    onChange: requestRender,
  });

  if (import.meta.env.DEV) window.__viewer = { renderer, camera, scene, flyRoot, rig, axes, picking };

  // Compile shaders before the first frame. Otherwise three.js compiles them on first
  // use and waits for each one, a multi-second main-thread stall where WebGL runs on the
  // CPU (Lighthouse measured 2.1 s). With KHR_parallel_shader_compile this doesn't block.
  await Promise.all([renderer.compileAsync(scene, camera), gizmo.compile()]);

  status.hidden = true;
  renderer.setAnimationLoop((now) => {
    const moved = rig.update(now);
    picking.update();
    if (!moved && !needsRender) return;
    needsRender = false;
    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
    gizmo.render();
  });
} catch (err) {
  status.textContent = `Could not load the fly model: ${err.message}`;
  console.error(err);
}
