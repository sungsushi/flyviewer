import { MathUtils, Matrix4, Quaternion, Raycaster, Sphere, Vector2, Vector3 } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TrackballControls } from 'three/addons/controls/TrackballControls.js';

const WORLD_UP = new Vector3(0, 1, 0);
const TRANSITION_MS = 400;
// Orbit mode keeps world-up fixed, so a view straight along it is degenerate. Views on
// the pole (dorsal, ventral) are tilted this far (radians) off it, on the side that puts
// their screen-up direction (the head) at the top.
const POLE_OFFSET = 1e-3;

// Home view, in three.js world space (Y-up). +z is the fly's right side (fly −y),
// so the head (fly +x = world +x) points right; slightly raised to show the back.
const HOME_DIR = new Vector3(0, 0.4, 1).normalize();

// Camera direction from the target, and screen-up, both in fly coordinates
// (+x anterior, +y fly's left, +z dorsal).
export const VIEW_PRESETS = {
  dorsal: { dir: [0, 0, 1], up: [1, 0, 0] },
  ventral: { dir: [0, 0, -1], up: [1, 0, 0] },
  left: { dir: [0, 1, 0], up: [0, 0, 1] },
  right: { dir: [0, -1, 0], up: [0, 0, 1] },
  anterior: { dir: [1, 0, 0], up: [0, 0, 1] },
  posterior: { dir: [-1, 0, 0], up: [0, 0, 1] },
};

// Distance at which a sphere of `radius` fills `fill` of the narrower view dimension.
function fitDistance(camera, radius, fill = 0.8) {
  const halfV = MathUtils.degToRad(camera.fov) / 2;
  const halfH = Math.atan(Math.tan(halfV) * camera.aspect);
  const alpha = Math.atan(fill * Math.tan(Math.min(halfV, halfH)));
  return radius / Math.sin(alpha);
}

const smoothstep = (t) => t * t * (3 - 2 * t);

/**
 * Orbit (default) or free-rotate (trackball) camera around the fly, with animated view
 * presets, reset, double-click re-centring and a serialisable state in fly coordinates.
 */
export function createCameraRig({ camera, domElement, flyRoot, box, bodyLength, onChange }) {
  const sphere = box.getBoundingSphere(new Sphere());
  const center = sphere.center.clone();
  const limits = { minDistance: 0.3 * bodyLength, maxDistance: 15 * bodyLength };

  const orbit = new OrbitControls(camera, domElement);
  Object.assign(orbit, {
    enableDamping: true,
    dampingFactor: 0.08,
    screenSpacePanning: true,
    zoomToCursor: true,
    ...limits,
  });

  const trackball = new TrackballControls(camera, domElement);
  Object.assign(trackball, {
    rotateSpeed: 3,
    staticMoving: true, // no inertia: its damping state is private and can't be stopped
    keys: [], // default A/S/D listen on window and would clash with app shortcuts
    ...limits,
  });
  trackball.disconnect();

  let controls = orbit;
  let anim = null;
  const notify = () => onChange?.();
  orbit.addEventListener('change', notify);
  trackball.addEventListener('change', notify);

  const flyToWorld = () => flyRoot.matrixWorld;
  const worldToFly = () => new Matrix4().copy(flyRoot.matrixWorld).invert();

  function isFree() {
    return controls === trackball;
  }

  function currentPose() {
    return {
      position: camera.position.clone(),
      target: controls.target.clone(),
      up: camera.up.clone(),
    };
  }

  function stopInertia() {
    if (controls === orbit) {
      // With damping off, one update applies and clears the pending rotate/pan deltas.
      orbit.enableDamping = false;
      orbit.update();
      orbit.enableDamping = true;
    }
  }

  // Orbit mode keeps camera.up = world-up, which leaves the screen orientation undefined
  // when looking straight along it. Tilt such an offset slightly so `screenUp` (or, if
  // that is itself vertical, the fly's head) ends up at the top of the screen.
  function offPole(offset, screenUp) {
    const s = offset.dot(WORLD_UP) / offset.length();
    if (Math.abs(s) < Math.cos(POLE_OFFSET / 2)) return offset; // already clearly off the pole
    let up = screenUp.clone().projectOnPlane(WORLD_UP);
    if (up.lengthSq() < 1e-6) up = new Vector3(1, 0, 0).transformDirection(flyToWorld()).projectOnPlane(WORLD_UP);
    const len = offset.length();
    return offset.normalize().addScaledVector(up.normalize(), -Math.sign(s) * POLE_OFFSET).setLength(len);
  }

  function orbitPose({ position, target, up }) {
    const offset = offPole(position.clone().sub(target), up ?? WORLD_UP);
    return { target, position: target.clone().add(offset), up: WORLD_UP.clone() };
  }

  function applyPose({ position, target, up }) {
    controls.target.copy(target);
    camera.position.copy(position);
    camera.up.copy(up);
    camera.lookAt(target);
    controls.update();
  }

  // Animate around the target: slerp the viewing direction, interpolate distance
  // geometrically, lerp the target, and (free mode only) slerp the up vector.
  function animateTo(pose, ms = TRANSITION_MS) {
    stopInertia();
    if (!isFree()) pose = orbitPose(pose);
    if (ms <= 0) {
      anim = null;
      controls.enabled = true;
      applyPose(pose);
      notify();
      return;
    }
    const from = currentPose();
    const fromOff = from.position.clone().sub(from.target);
    const toOff = pose.position.clone().sub(pose.target);
    anim = {
      start: performance.now(),
      ms,
      from,
      to: pose,
      fromDir: fromOff.clone().normalize(),
      fromLen: fromOff.length(),
      toLen: toOff.length(),
      dirRot: new Quaternion().setFromUnitVectors(fromOff.normalize(), toOff.normalize()),
      upRot: new Quaternion().setFromUnitVectors(
        from.up.clone().normalize(),
        pose.up.clone().normalize(),
      ),
    };
    controls.enabled = false;
  }

  const _q = new Quaternion();
  const _dir = new Vector3();
  const _target = new Vector3();

  function stepAnimation(now) {
    const t = Math.min(1, (now - anim.start) / anim.ms);
    if (t >= 1) {
      const { to } = anim;
      anim = null;
      controls.enabled = true;
      applyPose(to);
      notify();
      return;
    }
    const e = smoothstep(t);
    _dir.copy(anim.fromDir).applyQuaternion(_q.identity().slerp(anim.dirRot, e));
    const len = anim.fromLen * (anim.toLen / anim.fromLen) ** e;
    _target.lerpVectors(anim.from.target, anim.to.target, e);
    camera.position.copy(_target).addScaledVector(_dir, len);
    camera.up.copy(anim.from.up).applyQuaternion(_q.identity().slerp(anim.upRot, e));
    camera.lookAt(_target);
  }

  // Pose looking at the fly's centre from world direction `dir`, with screen-up `up`.
  // (animateTo applies the orbit-mode pole handling.)
  function poseAlong(dir, up) {
    const distance = fitDistance(camera, sphere.radius);
    return {
      target: center.clone(),
      position: center.clone().addScaledVector(dir.clone().normalize(), distance),
      up: up.clone(),
    };
  }

  function viewPreset(name) {
    const preset = VIEW_PRESETS[name];
    const dir = new Vector3(...preset.dir).transformDirection(flyToWorld());
    const up = new Vector3(...preset.up).transformDirection(flyToWorld());
    animateTo(poseAlong(dir, up));
  }

  function reset(ms = TRANSITION_MS) {
    animateTo(poseAlong(HOME_DIR, WORLD_UP), ms);
  }

  function setFree(on) {
    if (on === isFree()) return;
    if (anim) stepAnimation(Infinity); // finish any transition first
    stopInertia();
    const pose = currentPose();
    controls.disconnect();
    controls = on ? trackball : orbit;
    controls.connect(domElement);
    // Entering orbit mode: keep the view direction and as much of the screen-up as possible.
    applyPose(on ? pose : orbitPose(pose));
    notify();
  }

  // Double-click a part: move the orbit target to that point, keeping the camera offset.
  const raycaster = new Raycaster();
  domElement.addEventListener('dblclick', (event) => {
    const rect = domElement.getBoundingClientRect();
    const ndc = new Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObject(flyRoot, true)[0];
    if (!hit) return;
    const pose = currentPose();
    const offset = pose.position.clone().sub(pose.target);
    animateTo({ target: hit.point, position: hit.point.clone().add(offset), up: pose.up });
  });

  // State in fly coordinates (mm), independent of the viewer's Y-up rotation.
  function getState() {
    const toFly = worldToFly();
    return {
      position: camera.position.clone().applyMatrix4(toFly).toArray(),
      target: controls.target.clone().applyMatrix4(toFly).toArray(),
      up: camera.up.clone().transformDirection(toFly).toArray(),
      free: isFree(),
    };
  }

  function setState({ position, target, up, free }, ms = TRANSITION_MS) {
    setFree(Boolean(free));
    const toWorld = flyToWorld();
    animateTo(
      {
        position: new Vector3(...position).applyMatrix4(toWorld),
        target: new Vector3(...target).applyMatrix4(toWorld),
        up: up ? new Vector3(...up).transformDirection(toWorld) : WORLD_UP.clone(),
      },
      ms,
    );
  }

  return {
    update(now) {
      if (anim) stepAnimation(now);
      else controls.update();
    },
    resize() {
      trackball.handleResize();
    },
    viewPreset,
    reset,
    setFree,
    isFree,
    getState,
    setState,
  };
}
