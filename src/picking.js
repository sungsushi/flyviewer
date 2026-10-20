import { Raycaster, Vector2 } from 'three';

const SIDES = { l: 'left', r: 'right' };
const LEGS = { f: 'front', m: 'middle', h: 'hind' };
const LINKS = {
  thorax: 'thorax',
  head: 'head',
  rostrum: 'rostrum (proboscis)',
  haustellum: 'haustellum (proboscis)',
  abdomen12: 'abdominal segments 1–2',
  eye: 'eye',
  pedicel: 'antenna, pedicel',
  funiculus: 'antenna, funiculus',
  arista: 'antenna, arista',
  wing: 'wing',
  haltere: 'haltere',
  coxa: 'coxa',
  trochanterfemur: 'trochanter–femur',
  tibia: 'tibia',
};

/** `lf_tibia` → "left front tibia", `c_abdomen3` → "abdominal segment 3". */
export function segmentLabel(name) {
  const [pos, link] = name.split('_');
  const part =
    LINKS[link] ??
    link.replace(/^abdomen(\d)$/, 'abdominal segment $1').replace(/^tarsus(\d)$/, 'tarsal segment $1');
  if (pos === 'c') return part;
  if (pos.length === 2) return `${SIDES[pos[0]]} ${LEGS[pos[1]]} ${part}`;
  return `${SIDES[pos]} ${part}`;
}

const TAP_MAX_MOVE_PX = 6;
const TAP_MAX_MS = 400;

/**
 * Hover readout: segment name and hit point in fly coordinates (mm) from the axes origin.
 * Raycasts at most once per animation frame, and only when the pointer or camera moved.
 * Touch screens have no hover, so a tap shows the readout instead.
 */
export function createPicking({ camera, domElement, flyRoot, axes, readout }) {
  const raycaster = new Raycaster();
  const ndc = new Vector2();
  let pointerInside = false;
  let dirty = false;
  let tap = null;

  function setPointer(event) {
    const rect = domElement.getBoundingClientRect();
    ndc.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    dirty = true;
  }

  domElement.addEventListener('pointermove', (event) => {
    if (event.pointerType !== 'mouse') return;
    pointerInside = true;
    setPointer(event);
  });
  domElement.addEventListener('pointerleave', (event) => {
    if (event.pointerType !== 'mouse') return;
    pointerInside = false;
    readout.hidden = true;
  });
  domElement.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse') return;
    tap = { x: event.clientX, y: event.clientY, t: performance.now() };
  });
  domElement.addEventListener('pointerup', (event) => {
    if (event.pointerType === 'mouse' || !tap) return;
    const moved = Math.hypot(event.clientX - tap.x, event.clientY - tap.y);
    if (moved <= TAP_MAX_MOVE_PX && performance.now() - tap.t <= TAP_MAX_MS) {
      pointerInside = true;
      setPointer(event);
    }
    tap = null;
  });

  const nameEl = readout.querySelector('.readout-name');
  const idEl = readout.querySelector('.readout-id');
  const posEl = readout.querySelector('.readout-pos');

  function pick() {
    raycaster.setFromCamera(ndc, camera);
    // Axes and planes opt out of raycasting, so only fly meshes can be hit.
    const hit = raycaster.intersectObject(flyRoot, true)[0];
    if (!hit) {
      readout.hidden = true;
      return;
    }
    // World → fly frame via flyRoot, not the hit mesh: meshopt quantisation gives every
    // node its own scale/offset, so mesh-local coordinates are not fly coordinates.
    const origin = axes.getOrigin();
    const p = flyRoot.worldToLocal(hit.point.clone()).sub(origin.position);
    const name = hit.object.name;
    nameEl.textContent = segmentLabel(name);
    idEl.textContent = name;
    posEl.textContent =
      `x ${p.x.toFixed(3)}  y ${p.y.toFixed(3)}  z ${p.z.toFixed(3)} mm ` +
      `(from ${origin.label})`;
    readout.hidden = false;
  }

  return {
    // The view or origin changed: what's under the pointer may have too.
    invalidate() {
      dirty = true;
    },
    update() {
      if (!dirty || !pointerInside) return;
      dirty = false;
      pick();
    },
  };
}
