import {
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  EdgesGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

// Anatomical axis pairs in fly coordinates (+x anterior, +y fly's left, +z dorsal).
// `plus` is the label at +axis, `minus` at −axis.
export const AXIS_PAIRS = {
  ap: { axis: 0, color: '#d94841', plus: ['A', 'Anterior'], minus: ['P', 'Posterior'] },
  dv: { axis: 2, color: '#3a7bd5', plus: ['D', 'Dorsal'], minus: ['V', 'Ventral'] },
  lr: { axis: 1, color: '#2e9e5b', plus: ['L', 'Left'], minus: ['R', 'Right'] },
};

// Anatomical planes through the origin. `axes` are the two in-plane fly axes (u, v).
const PLANES = {
  sagittal: { axes: [0, 2], label: 'Sagittal' },
  horizontal: { axes: [0, 1], label: 'Horizontal' },
  transverse: { axes: [1, 2], label: 'Transverse' },
};

const RENDER_ORDER = 10; // after the fly, including the transparent wings (1)
const PLANE_RENDER_ORDER = 5; // after the wings, before the axes
const Y = new Vector3(0, 1, 0);
const noRaycast = () => {};

function makeLabel([letter, word], color) {
  const el = document.createElement('div');
  el.className = 'axis-label';
  el.style.setProperty('--axis-color', color);
  el.setAttribute('aria-label', word);
  el.title = word;
  el.innerHTML = `<span class="short">${letter}</span><span class="long">${word}</span>`;
  return new CSS2DObject(el);
}

/**
 * Build the three axis pairs (and the optional anatomical planes) as children of
 * `flyRoot`, so they are authored in fly coordinates and always match the body.
 *
 * @param flyRoot  group holding the fly in its native frame
 * @param meta     fly.meta.json: bbox (fly frame), bodyLength, thoraxOrigin
 */
export function createAxes(flyRoot, meta) {
  const L = meta.bodyLength;
  const bbMin = new Vector3(...meta.bbox.min);
  const bbMax = new Vector3(...meta.bbox.max);
  const extent = bbMax.clone().sub(bbMin);
  const origins = {
    center: bbMin.clone().add(bbMax).multiplyScalar(0.5),
    thorax: new Vector3(...meta.thoraxOrigin),
  };

  const shaftRadius = 0.01 * L;
  const coneRadius = 0.03 * L;
  const coneLength = 0.09 * L;
  const minHalf = 0.35 * L; // keeps the shortest axis readable
  const labelGap = 0.08 * L;

  const root = new Group();
  root.name = 'anatomicalAxes';
  root.position.copy(origins.center);
  flyRoot.add(root);

  const materials = [];
  const groups = {};
  for (const [key, pair] of Object.entries(AXIS_PAIRS)) {
    const dir = new Vector3().setComponent(pair.axis, 1);
    const half = Math.max(0.65 * extent.getComponent(pair.axis), minHalf);
    const material = new MeshBasicMaterial({
      color: new Color(pair.color),
      // Fully opaque, but in the transparent pass: three.js draws all opaque objects
      // before any transparent one regardless of renderOrder, so this is what lets the
      // axes draw after (on top of) the translucent wings.
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    materials.push(material);

    const group = new Group();
    group.name = `axis-${key}`;
    // Build along +y (the default cylinder/cone axis), then rotate onto the pair's axis.
    const along = new Group();
    along.quaternion.copy(new Quaternion().setFromUnitVectors(Y, dir));
    group.add(along);

    const shaft = new Mesh(new CylinderGeometry(shaftRadius, shaftRadius, 2 * (half - coneLength), 12), material);
    const tipPlus = new Mesh(new ConeGeometry(coneRadius, coneLength, 20), material);
    tipPlus.position.y = half - coneLength / 2;
    const tipMinus = tipPlus.clone();
    tipMinus.position.y = -tipPlus.position.y;
    tipMinus.rotation.z = Math.PI;
    for (const mesh of [shaft, tipPlus, tipMinus]) {
      mesh.renderOrder = RENDER_ORDER;
      mesh.raycast = noRaycast; // hover/double-click picking should only see the fly
      along.add(mesh);
    }

    const labelPlus = makeLabel(pair.plus, pair.color);
    labelPlus.position.y = half + labelGap;
    const labelMinus = makeLabel(pair.minus, pair.color);
    labelMinus.position.y = -(half + labelGap);
    along.add(labelPlus, labelMinus);

    root.add(group);
    groups[key] = group;
  }

  // --- Planes (off by default) ----------------------------------------------
  // Sized to cover the body from either origin.
  const halfSpan = [0, 1, 2].map(
    (i) =>
      1.05 *
      Math.max(
        ...Object.values(origins).flatMap((o) => [
          Math.abs(bbMax.getComponent(i) - o.getComponent(i)),
          Math.abs(bbMin.getComponent(i) - o.getComponent(i)),
        ]),
      ),
  );
  const planeMaterial = new MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.18,
    side: DoubleSide,
    depthWrite: false,
  });
  const edgeMaterial = new LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 });
  const planes = new Group();
  planes.name = 'anatomicalPlanes';
  planes.visible = false;
  root.add(planes);
  for (const [name, { axes: [u, v], label }] of Object.entries(PLANES)) {
    // PlaneGeometry lies in its local x–y; map local x → fly axis u and local y → fly axis v.
    const geometry = new PlaneGeometry(2 * halfSpan[u], 2 * halfSpan[v]);
    if (v === 2) geometry.rotateX(Math.PI / 2); // local y → +z
    if (u === 1) geometry.rotateZ(Math.PI / 2); // local x → +y
    const plane = new Mesh(geometry, planeMaterial);
    const edges = new LineSegments(new EdgesGeometry(geometry), edgeMaterial);
    plane.name = `plane-${name}`;
    for (const obj of [plane, edges]) {
      obj.renderOrder = PLANE_RENDER_ORDER;
      obj.raycast = noRaycast;
    }
    const tag = document.createElement('div');
    tag.className = 'plane-label';
    tag.textContent = label;
    const tagObject = new CSS2DObject(tag);
    tagObject.position.setComponent(u, halfSpan[u]).setComponent(v, halfSpan[v]);
    tagObject.center.set(0, 1); // label's bottom-left corner sits on the plane's corner
    plane.add(edges, tagObject);
    planes.add(plane);
  }

  let originName = 'center';

  return {
    // Hiding a group also hides its CSS2D labels: CSS2DRenderer in three r186 skips
    // (and hides) the whole subtree of an invisible object.
    setVisible(key, visible) {
      groups[key].visible = visible;
    },
    isVisible(key) {
      return groups[key].visible;
    },
    setOrigin(name) {
      originName = name in origins ? name : 'center';
      root.position.copy(origins[originName]);
    },
    // Current origin in fly coordinates (mm), with a human-readable name.
    getOrigin() {
      return {
        position: origins[originName].clone(),
        label: originName === 'thorax' ? 'thorax' : 'body centre',
      };
    },
    setPlanesVisible(visible) {
      planes.visible = visible;
    },
    planesVisible() {
      return planes.visible;
    },
    // false: axes draw over the body (default); true: the body can hide them.
    setBehindBody(behind) {
      for (const m of materials) m.depthTest = behind;
    },
  };
}
