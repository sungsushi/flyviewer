// UI bindings (buttons, checkboxes, keyboard) and URL-hash state.
//
// Hash format, `&`-separated, unknown keys preserved:
//   cam=px,py,pz,tx,ty,tz   camera position and orbit target, fly frame, mm
//   up=ux,uy,uz             camera up, fly frame (free-rotate only)
//   free                    free-rotate mode
//   axes=ap,dv              visible axis pairs (absent: all; bare `axes`: none)
//   origin=thorax           axes origin (absent: bounding-box centre)
//   behind                  axes are hidden by the body
//   planes                  anatomical planes shown

import { AXIS_PAIRS } from './axes.js';

const HASH_WRITE_DELAY_MS = 250;
const AXIS_KEYS = Object.keys(AXIS_PAIRS);
const AXIS_SHORTCUTS = { 1: 'ap', 2: 'dv', 3: 'lr' };

function readHash() {
  const params = new Map();
  for (const part of location.hash.slice(1).split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    if (i < 0) params.set(decodeURIComponent(part), '');
    else params.set(decodeURIComponent(part.slice(0, i)), decodeURIComponent(part.slice(i + 1)));
  }
  return params;
}

function writeHash(params) {
  const hash = [...params].map(([k, v]) => (v === '' ? k : `${k}=${v}`)).join('&');
  history.replaceState(null, '', hash ? `#${hash}` : location.pathname + location.search);
}

function parseNumbers(text, count) {
  const values = (text ?? '').split(',').map(Number);
  return values.length === count && values.every(Number.isFinite) ? values : null;
}

const fmt = (values, digits) => values.map((v) => +v.toFixed(digits)).join(',');

function cameraStateFromHash(params) {
  const cam = parseNumbers(params.get('cam'), 6);
  if (!cam) return null;
  const free = params.has('free');
  return {
    position: cam.slice(0, 3),
    target: cam.slice(3),
    up: free ? parseNumbers(params.get('up'), 3) : null,
    free,
  };
}

function axesStateFromHash(params) {
  const visible = params.has('axes')
    ? new Set(params.get('axes').split(',').filter((k) => AXIS_KEYS.includes(k)))
    : new Set(AXIS_KEYS);
  return {
    visible,
    origin: params.get('origin') === 'thorax' ? 'thorax' : 'center',
    behind: params.has('behind'),
    planes: params.has('planes'),
  };
}

export function initUI({ rig, axes, onAxesChange = () => {} }) {
  const freeToggle = document.getElementById('free-rotate');
  const axisToggles = Object.fromEntries(
    AXIS_KEYS.map((key) => [key, document.querySelector(`[data-axis="${key}"]`)]),
  );
  const allAxesToggle = document.getElementById('axes-all');
  const originSelect = document.getElementById('axes-origin');
  const behindToggle = document.getElementById('axes-behind');
  const planesToggle = document.getElementById('planes');

  // --- Axes ------------------------------------------------------------------
  function applyAxesState({ visible, origin, behind, planes }) {
    for (const key of AXIS_KEYS) axes.setVisible(key, visible.has(key));
    axes.setOrigin(origin);
    axes.setBehindBody(behind);
    axes.setPlanesVisible(planes);
    syncAxesControls();
    onAxesChange();
  }

  function axesState() {
    return {
      visible: new Set(AXIS_KEYS.filter((key) => axes.isVisible(key))),
      origin: originSelect.value,
      behind: behindToggle.checked,
      planes: planesToggle.checked,
    };
  }

  function syncAxesControls() {
    const shown = AXIS_KEYS.filter((key) => axes.isVisible(key));
    for (const key of AXIS_KEYS) axisToggles[key].checked = axes.isVisible(key);
    allAxesToggle.checked = shown.length === AXIS_KEYS.length;
    allAxesToggle.indeterminate = shown.length > 0 && shown.length < AXIS_KEYS.length;
  }

  function writeAxesHash() {
    const { visible, origin, behind, planes } = axesState();
    const params = readHash();
    if (visible.size === AXIS_KEYS.length) params.delete('axes');
    else params.set('axes', AXIS_KEYS.filter((key) => visible.has(key)).join(','));
    if (origin === 'center') params.delete('origin');
    else params.set('origin', origin);
    if (behind) params.set('behind', '');
    else params.delete('behind');
    if (planes) params.set('planes', '');
    else params.delete('planes');
    writeHash(params);
  }

  function setAxis(key, visible) {
    axes.setVisible(key, visible);
    syncAxesControls();
    writeAxesHash();
  }

  function toggleAllAxes() {
    const showAll = AXIS_KEYS.some((key) => !axes.isVisible(key));
    for (const key of AXIS_KEYS) axes.setVisible(key, showAll);
    syncAxesControls();
    writeAxesHash();
  }

  for (const [key, toggle] of Object.entries(axisToggles)) {
    toggle.addEventListener('change', () => setAxis(key, toggle.checked));
  }
  allAxesToggle.addEventListener('change', toggleAllAxes);
  originSelect.addEventListener('change', () => {
    axes.setOrigin(originSelect.value);
    onAxesChange(); // the readout is measured from the origin
    writeAxesHash();
  });
  planesToggle.addEventListener('change', () => {
    axes.setPlanesVisible(planesToggle.checked);
    writeAxesHash();
  });
  behindToggle.addEventListener('change', () => {
    axes.setBehindBody(behindToggle.checked);
    writeAxesHash();
  });

  function applyAxesHash() {
    const state = axesStateFromHash(readHash());
    originSelect.value = state.origin;
    behindToggle.checked = state.behind;
    planesToggle.checked = state.planes;
    applyAxesState(state);
  }

  // --- Camera ----------------------------------------------------------------

  for (const button of document.querySelectorAll('[data-view]')) {
    button.addEventListener('click', () => rig.viewPreset(button.dataset.view));
  }
  document.getElementById('reset-view').addEventListener('click', () => rig.reset());
  freeToggle.addEventListener('change', () => rig.setFree(freeToggle.checked));

  window.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
    if (event.target.closest?.('input, textarea, select')) return;
    if (event.key === 'r' || event.key === 'R') rig.reset();
    else if (event.key === 'a' || event.key === 'A') toggleAllAxes();
    else if (AXIS_SHORTCUTS[event.key]) {
      const key = AXIS_SHORTCUTS[event.key];
      setAxis(key, !axes.isVisible(key));
    }
  });

  // Camera → hash (debounced; replaceState so views don't flood the history).
  let writeTimer = 0;
  function scheduleHashWrite() {
    clearTimeout(writeTimer);
    writeTimer = setTimeout(() => {
      const state = rig.getState();
      const params = readHash();
      params.set('cam', fmt([...state.position, ...state.target], 3));
      if (state.free) {
        params.set('up', fmt(state.up, 4));
        params.set('free', '');
      } else {
        params.delete('up');
        params.delete('free');
      }
      writeHash(params);
    }, HASH_WRITE_DELAY_MS);
  }

  // Hash → camera: on load (instant) and when the user edits or pastes a URL (animated).
  function applyCameraHash(ms) {
    const state = cameraStateFromHash(readHash());
    if (state) rig.setState(state, ms);
    else if (ms === 0) rig.reset(0);
    freeToggle.checked = rig.isFree();
  }
  window.addEventListener('hashchange', () => {
    applyCameraHash();
    applyAxesHash();
  });

  applyCameraHash(0);
  applyAxesHash();
  return { onCameraChange: scheduleHashWrite };
}
