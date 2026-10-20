import {
  BoxGeometry,
  CanvasTexture,
  Color,
  EdgesGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  Raycaster,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
} from 'three';
import { AXIS_PAIRS } from './axes.js';
import { VIEW_PRESETS } from './camera.js';

// BoxGeometry material order is +x, −x, +y, −y, +z, −z; in the fly frame that is:
const FACES = [
  { preset: 'anterior', pair: 'ap', label: 'A' },
  { preset: 'posterior', pair: 'ap', label: 'P' },
  { preset: 'left', pair: 'lr', label: 'L' },
  { preset: 'right', pair: 'lr', label: 'R' },
  { preset: 'dorsal', pair: 'dv', label: 'D' },
  { preset: 'ventral', pair: 'dv', label: 'V' },
];
const HOVER_TINT = new Color(0.82, 0.82, 0.82);

// For each box face, the texture's +u and +v directions in the cube's (fly) frame,
// from the first triangle of each material group.
function faceUVAxes(geometry) {
  const pos = geometry.attributes.position;
  const uv = geometry.attributes.uv;
  const index = geometry.index;
  return geometry.groups.map(({ start }) => {
    const [i0, i1, i2] = [0, 1, 2].map((k) => index.getX(start + k));
    const p0 = new Vector3().fromBufferAttribute(pos, i0);
    const e1 = new Vector3().fromBufferAttribute(pos, i1).sub(p0);
    const e2 = new Vector3().fromBufferAttribute(pos, i2).sub(p0);
    const [du1, dv1] = [uv.getX(i1) - uv.getX(i0), uv.getY(i1) - uv.getY(i0)];
    const [du2, dv2] = [uv.getX(i2) - uv.getX(i0), uv.getY(i2) - uv.getY(i0)];
    const r = 1 / (du1 * dv2 - du2 * dv1);
    const u = e1.clone().multiplyScalar(dv2).addScaledVector(e2, -dv1).multiplyScalar(r);
    const v = e2.clone().multiplyScalar(du1).addScaledVector(e1, -du2).multiplyScalar(r);
    return { u: u.normalize(), v: v.normalize() };
  });
}

// Draw the letter rotated so it reads upright when the face is seen from its own
// preset, i.e. with that preset's screen-up (`up`, fly frame) at the top.
function faceTexture(letter, color, { u, v }, up) {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f4f5f6';
  ctx.fillRect(0, 0, size, size);
  ctx.lineWidth = 12;
  ctx.strokeStyle = color;
  ctx.strokeRect(6, 6, size - 12, size - 12);
  // Canvas x runs along +u and canvas y along −v (the texture is flipped on upload).
  // Rotating by θ turns the letter's up (0, −1) into (sin θ, −cos θ) = (up·u, −up·v).
  const angle = Math.atan2(up.dot(u), up.dot(v));
  ctx.translate(size / 2, size / 2);
  ctx.rotate(angle);
  ctx.fillStyle = '#1d1f22';
  ctx.font = '700 72px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(letter, 0, 4);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

/**
 * Corner orientation cube. It lives in its own scene, oriented like flyRoot, and is
 * drawn into the area of `element` (an overlay that also takes the clicks, so they
 * don't reach the orbit controls). Clicking a face runs that face's view preset.
 */
export function createGizmo({ renderer, camera, flyRoot, element, onFace, onChange = () => {} }) {
  const scene = new Scene();
  const gizmoCamera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10);

  const cube = new Group();
  cube.quaternion.copy(flyRoot.quaternion); // fly frame → world, same as the fly
  scene.add(cube);

  const geometry = new BoxGeometry(1, 1, 1);
  const uvAxes = faceUVAxes(geometry);
  const materials = FACES.map(
    ({ pair, label, preset }, i) =>
      new MeshBasicMaterial({
        map: faceTexture(label, AXIS_PAIRS[pair].color, uvAxes[i], new Vector3(...VIEW_PRESETS[preset].up)),
      }),
  );
  const box = new Mesh(geometry, materials);
  box.add(
    new LineSegments(
      new EdgesGeometry(box.geometry),
      new LineBasicMaterial({ color: 0x1d1f22, transparent: true, opacity: 0.4 }),
    ),
  );
  cube.add(box);

  const raycaster = new Raycaster();
  const ndc = new Vector2();
  let hovered = -1;

  function faceAt(event) {
    const rect = element.getBoundingClientRect();
    ndc.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, gizmoCamera);
    const hit = raycaster.intersectObject(box, false)[0];
    return hit ? hit.face.materialIndex : -1;
  }

  function setHovered(index) {
    if (index === hovered) return;
    if (hovered >= 0) materials[hovered].color.set(0xffffff);
    if (index >= 0) materials[index].color.copy(HOVER_TINT);
    hovered = index;
    onChange(); // the highlight needs a redraw
    element.style.cursor = index >= 0 ? 'pointer' : '';
    element.title = index >= 0 ? `${FACES[index].preset} view` : '';
  }

  element.addEventListener('pointermove', (event) => setHovered(faceAt(event)));
  element.addEventListener('pointerleave', () => setHovered(-1));
  element.addEventListener('click', (event) => {
    const index = faceAt(event);
    if (index >= 0) onFace(FACES[index].preset);
  });

  return {
    // Compile the cube's shaders without blocking the main thread (see main.js).
    compile() {
      return renderer.compileAsync(scene, gizmoCamera);
    },
    // Call after the main render. Draws into the overlay element's rectangle.
    render() {
      // Look at the cube from the same direction the main camera looks at the fly.
      gizmoCamera.quaternion.copy(camera.quaternion);
      gizmoCamera.position.set(0, 0, 3).applyQuaternion(camera.quaternion);

      const canvasRect = renderer.domElement.getBoundingClientRect();
      const r = element.getBoundingClientRect();
      const x = r.left - canvasRect.left;
      const y = canvasRect.bottom - r.bottom; // viewport y is measured from the bottom

      renderer.setScissorTest(true);
      renderer.setScissor(x, y, r.width, r.height);
      renderer.setViewport(x, y, r.width, r.height);
      renderer.autoClear = false;
      renderer.clearDepth();
      renderer.render(scene, gizmoCamera);
      renderer.autoClear = true;
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, canvasRect.width, canvasRect.height);
    },
  };
}
