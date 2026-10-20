# Drosophila 3D Browser Viewer — Resources & Build Guide

Oct 20, 2026 · @s

## Goal and scope

Build a static, single-page browser viewer of an adult *Drosophila melanogaster* using the NeuroMechFly meshes from flygym, baked once into a \~1 MB glTF file and rendered with three.js. The user can rotate, zoom and pan the fly, and toggle anatomical axis overlays for anterior–posterior, dorsal–ventral and left–right.

**In scope:** one static pose (flygym's neutral resting pose), orbit/zoom/pan camera, view presets, per-axis toggles with labels, an optional corner orientation gizmo and a hover readout of segment name and position.

**Out of scope (v1):** animation, physics, joint manipulation, the FlyBody alternative model, and the full-resolution meshes. Each is listed as a later extension in the milestones.

## Source assets in flygym

Everything needed is bundled in [NeuroMechFly/flygym](https://github.com/NeLy-EPFL/flygym) at version 2.1.0 (commit `38c8ec6`, 29 Jun 2026), licensed Apache-2.0. Pin that commit in the bake script so the build is reproducible.

*Verified in M0:* `38c8ec6` is not the `v2.1.0` tag itself (`ca65a51`, 24 Jun 2026) but 7 commits later; those commits touch only `docs/` and `wasm/`. The PyPI `flygym==2.1.0` wheel's `assets/`, `anatomy.py` and `compose/` are byte-identical to the pinned commit.

All paths below are relative to `src/flygym/assets/model/neuromechfly/`.

| Asset | Path | What it holds | Notes |
| --- | --- | --- | --- |
| Meshes | `meshes/simplified_max2000faces/*.stl` | 39 binary STL files, at most 2,000 triangles each, about 3.2 MB in total | Central and **left-side parts only**; the right side is the left mesh mirrored in y |
| Rigging | `rigging.yaml` | Per segment (all 69, right side explicit): `pos` (mm), `quat` (w, x, y, z), mass | `pos`/`quat` are **relative to the parent segment**; root `c_thorax` sits at (0.496, 0, 1.3) mm |
| Kinematic tree | `src/flygym/anatomy.py` → `ALL_CONNECTED_SEGMENT_PAIRS` | Parent → child pairs | thorax → head, abdomen chain, wings, halteres, 6 legs; head → eyes, antennae, proboscis |
| Neutral pose | `pose/neutral/pitch_roll_yaw.yaml` (and 5 other axis orders) | Joint angles in degrees, left legs only | Right side mirrored by flygym when loaded |
| Colors | `visuals.yaml` | Material (RGBA, specular, shininess) and optional procedural texture per segment glob | Eyes, wings, aristae, halteres use `rgba` directly (eyes `[0.67, 0.21, 0.12]`, wings 30 % opaque). All other sets have `rgba: [1,1,1,1]` and the colour in `texture.rgb1` (`flat`) or `rgb1`→`rgb2` (`gradient`), with random speckle marks |
| Mesh loader logic | `src/flygym/compose/fly/neuromechfly.py` | `SCALE = 1000`, `y_sign = -1` for `r*` segments | Read this to confirm the mirroring rule |

**Segment names.** The model has 69 segments. Central: `c_thorax`, `c_head`, `c_rostrum`, `c_haustellum`, `c_abdomen12`, `c_abdomen3`–`c_abdomen6`. Per side (`l_`/`r_`): `eye`, `pedicel`, `funiculus`, `arista`, `wing`, `haltere`. Per leg (`lf`, `lm`, `lh`, `rf`, `rm`, `rh`): `coxa`, `trochanterfemur`, `tibia`, `tarsus1`–`tarsus5`.

**Getting the files.** For inspection and the browser-only fallback, a sparse checkout is enough: run `tools/fetch_flygym.sh`, which does a partial (not shallow) clone into `vendor/flygym/` and checks out the pinned commit. Do not use `--depth 1`: a shallow clone only contains the tip of `main`, so checking out the pinned commit fails as soon as `main` moves past it. Note that `anatomy.py` imports `flygym.utils`, so it is not importable from the sparse checkout alone; use the installed package for Python access.

For the recommended bake, install the package instead (`pip install -r tools/requirements.txt`: `flygym==2.1.0`, `mujoco==3.9.0` and exact pins for the rest; Python 3.12–3.14).

**Alternatives, not used in v1.** Full-resolution NeuroMechFly meshes are downloaded lazily from flygym's S3 bucket (`neuromechfly_fullsize_meshes_20260623a`). flygym also ships the FlyBody model config under `assets/model/flybody/`, but its meshes are not in the repo either. Both can be swapped in later through the same bake script.

## Coordinate system and units

The model is right-handed, Z-up, in millimetres, and its axes map directly onto anatomical directions. I verified this from the STL bounds and `rigging.yaml`: the head sits at +x, the left wing at +y, the legs hang toward −z.

| Fly-frame axis | + direction | − direction | Evidence |
| --- | --- | --- | --- |
| x | Anterior (head) | Posterior (abdomen) | head offset +0.029 mm, abdomen offset −0.862 mm from thorax |
| y | Fly's **left** | Fly's right | `l_wing` at y = +0.395, `r_wing` at y = −0.395 |
| z | Dorsal | Ventral | legs chain along −z; thorax raised to z = +1.3 |

**Units.** Raw STL vertices are in metres (the thorax spans about 0.001 in x). flygym multiplies by `SCALE = 1000`, so all rigging offsets and the baked GLB are in millimetres. The whole fly is about 2.5–3 mm long.

**Mapping to three.js (Y-up).** Keep the fly in its native frame inside a root `Group` (`flyRoot`) and rotate that group once: `flyRoot.rotation.x = -Math.PI / 2`. This maps fly +z (dorsal) to screen-up. The axis overlays are children of `flyRoot`, so they are authored in fly coordinates and can never drift from the anatomy.

**Quaternion order.** `rigging.yaml` stores quaternions as (w, x, y, z), MuJoCo's order. three.js `Quaternion.set()` takes (x, y, z, w). This matters only for the browser-only fallback; the bake step handles it for you.

**Mirroring.** Right-side meshes are the left meshes scaled by (1, −1, 1). A negative scale flips triangle winding, so mirrored parts render inside-out unless the face order is reversed (or normals recomputed) when mirroring. *Verified in M1:* in the bake, MuJoCo already reverses the faces of the mirrored meshes (every `r_*` mesh has the same positive signed volume as its `l_*` twin); the bake asserts this. Only the browser-only fallback must reverse face order itself.

## Asset pipeline: bake one GLB

Bake the posed fly offline into a single `fly.glb` with one named node per segment, then ship only that file. Let MuJoCo do the forward kinematics so the browser never has to reproduce flygym's joint conventions (pitch = y, roll = z, yaw = x, multi-DoF axis orders).

**Why bake rather than load STLs live.** In the zero pose that `rigging.yaml` describes, all six legs point straight down, which does not look like a fly. The natural resting pose needs joint angles applied in flygym's axis order, which is easy to get subtly wrong in JavaScript. One GLB is also a single request and roughly 3× smaller than 69 STL fetches.

### Steps for `tools/bake_fly.py`

1. Create a venv (Python 3.12+) and `pip install -r tools/requirements.txt` (exact pins, including `trimesh`). Run `npm ci` for the pinned glTF-Transform CLI.
2. Build the model: `fly = NeuroMechFly()` from `flygym.compose`. Its defaults already use the simplified meshes and mirror left to right.
3. Add joints with the neutral pose (API verified against 2.1.0 source and tutorial 1a): `fly.add_joints(Skeleton(axis_order=AxisOrder.ROLL_PITCH_YAW, joint_preset=JointPreset.ALL_BIOLOGICAL), neutral_pose=KinematicPosePreset.NEUTRAL)`, with `Skeleton`, `AxisOrder`, `JointPreset` from `flygym.anatomy`. `add_joints` picks the pose file matching the skeleton's axis order automatically. Use roll-pitch-yaw: it is the order the pose was authored in (`pose/_manual_specs/neutral.yaml`); the other five files are conversions rounded to whole degrees and move leg tips by up to ~80 µm. The pose sets leg joints only (left side, mirrored to the right by flygym).
4. `model, data = fly.compile()`, then load the `neutral` keyframe (`mujoco.mj_resetDataKeyframe`) and run `mujoco.mj_kinematics(model, data)`.
5. For every geom of type mesh: take its vertices `model.mesh_vert[vertadr : vertadr + vertnum]` and faces `model.mesh_face[...]`, and transform them by the geom's world pose (`data.geom_xpos`, `data.geom_xmat`). Use MuJoCo's arrays, not the raw STL, because MuJoCo recentres each mesh on its centre of mass and stores the offset in the geom pose.
6. Name each output mesh by its body segment (`model.body(model.geom_bodyid[i]).name`; a standalone `fly.compile()` has no name prefix to strip), so the browser can show names on hover.
7. Assign a material per segment from `visuals.yaml` (glob match on `apply_to`, exactly one set per segment). Bake a flat colour: `rgba.rgb × texture.rgb1` (or the mean of `rgb1` and `rgb2` for `gradient`), dropping the speckle marks, and convert from sRGB to linear for the glTF base colour. Mark wings as transparent (`BLEND`, double-sided).
8. Write `fly.glb` with trimesh as a scene of 69 named nodes, all in fly-frame millimetres. Do **not** rotate to Y-up here; the viewer does that.
9. Optimise with glTF-Transform, pinned as a devDependency: `gltf-transform optimize fly.glb public/fly.glb --compress meshopt --simplify false --palette false --join false --flatten false --instance false`. The CLI defaults would otherwise simplify the meshes (lossy), merge materials into a palette texture and join/flatten nodes. Target under 1.5 MB (result: 0.62 MB). Quantisation adds a translation/scale to each node; vertices are no longer in fly coordinates without it.
10. Write `public/fly.meta.json` with the bounding box, body-length estimate, the thorax origin and the flygym commit, for the viewer and for attribution.

**Validation.** The bake itself asserts 69 flat, segment-named nodes, positive signed volume (outward winding) for every mesh, matching left/right volumes and a size under 1.5 MB. Then load the GLB in [gltf.report](https://gltf.report) or the three.js editor and check by eye.

### Fallback: browser-only zero pose

Useful for a first milestone without Python. Load each STL with three.js `STLLoader`, scale by 1000, and build an `Object3D` tree from `ALL_CONNECTED_SEGMENT_PAIRS`, applying each child's parent-relative `pos` and `quat` from `rigging.yaml`. For `r_*` segments, load the `l_*` STL, scale y by −1 and reverse triangle order. Because STL vertices are already in the body frame, no recentring is needed here. Expect straight legs.

## Viewer architecture and stack

Use plain three.js with ES modules, built by Vite, and no UI framework. The whole viewer should stay under about 200 KB of JavaScript (gzipped) plus the GLB, and deploy as static files to GitHub Pages.

&#91;embedded content: build-to-browser flow · 1 bake step, 1 hand-off file\]

Python runs once to produce the GLB; after that the viewer is pure static files, and every overlay hangs off the same `flyRoot` group as the meshes.

| Concern | Choice | Why |
| --- | --- | --- |
| Rendering | [three.js](https://threejs.org), pinned exact version | Small, mature, has every control and loader needed |
| Model loading | `GLTFLoader` + `MeshoptDecoder` | Matches the meshopt-compressed GLB |
| Camera | `OrbitControls` (default), `TrackballControls` (optional) | Rotate, zoom and pan out of the box |
| Axis labels | `CSS2DRenderer` + `CSS2DObject` | Crisp HTML text that always faces the camera |
| UI | Plain HTML checkboxes and buttons | No framework needed for \~10 controls |
| Build / dev | Vite | Serves `fly.glb` over HTTP (`file://` breaks loaders) and bundles for Pages |

**Alternatives considered.** Google's `<model-viewer>` needs almost no code but makes custom 3D overlays such as axes awkward. Babylon.js works but is several times heavier. Running MuJoCo's WASM build in the browser would allow posing live but adds megabytes for a static view.

**Modules (`src/`).**

- `main.js` creates the renderer, scene, camera and render loop, and wires the other modules together.
- `loadFly.js` loads `fly.glb`, puts it under `flyRoot`, applies the Y-up rotation and returns the bounding box.
- `camera.js` sets up controls, fits the camera to the fly and implements view presets and reset.
- `axes.js` builds the anatomical axes in fly coordinates and exposes `setVisible(pair, bool)`.
- `gizmo.js` renders the optional corner orientation cube in its own small scene.
- `picking.js` raycasts on pointer move and reports segment name and fly-frame position.
- `ui.js` binds checkboxes, buttons and keyboard shortcuts, and keeps state in the URL hash.

**Scene setup.** Use a `HemisphereLight` plus one `DirectionalLight` attached to the camera, so the fly is always lit from the viewer's side. Set `renderer.outputColorSpace = SRGBColorSpace` and a neutral grey background that works in light and dark mode. Render wings last with `depthWrite: false` to avoid transparency artefacts.

## Camera: rotate, zoom, pan

`OrbitControls` covers all three interactions; the main work is scaling it to a 3 mm object and adding view presets.

| Input | Action |
| --- | --- |
| Left drag / one-finger drag | Rotate around the target |
| Wheel / pinch | Zoom (dolly toward the cursor with `zoomToCursor = true`) |
| Right drag / Shift + drag / two-finger drag | Pan |
| Double-click a part | Re-centre the orbit target on that point |
| `R` | Reset view |

**Settings.**

- `PerspectiveCamera(35, aspect, 0.01, 100)` in millimetres. A near plane of 0.01 mm keeps close-ups from clipping; a far plane of 100 mm avoids depth-buffer precision loss.
- `enableDamping = true`, `dampingFactor = 0.08`, `screenSpacePanning = true`.
- `minDistance = 0.3 × L`, `maxDistance = 15 × L`, where L is the body length from `fly.meta.json`.
- Fit on load: compute the `Box3` of `flyRoot`, set the target to its centre and back the camera off until the bounding sphere fills about 80 % of the view height.

**Free rotation.** Orbit controls lock the up vector, so the fly cannot be rolled upside down past the pole. Offer a "Free rotate" toggle that swaps in `TrackballControls`, which allows any orientation. Keep orbit as the default since it is less disorienting.

**View presets.** Six buttons place the camera along a fly-frame axis, looking at the centre. Convert each direction with `flyRoot.localToWorld` so they stay correct after the Y-up rotation.

| Button | Camera direction (fly frame) | Camera up (fly frame) |
| --- | --- | --- |
| Dorsal | +z | +x (head toward top of screen) |
| Ventral | −z | +x |
| Left lateral | +y | +z |
| Right lateral | −y | +z |
| Anterior | +x | +z |
| Posterior | −x | +z |

Animate preset changes over about 400 ms (slerp the camera position around the target) so the user keeps their bearings. Store camera position and target in the URL hash so a view can be shared.

## Anatomical axes and toggles

Draw three double-headed, labelled axes in the fly frame, each toggled independently. Because they are children of `flyRoot`, they rotate with the fly and always point at the true body directions.

| Axis pair | Fly-frame vector | Labels | Colour (with text label, never colour alone) | Shortcut |
| --- | --- | --- | --- | --- |
| Anterior–posterior | ±x | A / P | Red `#d94841` | `1` |
| Dorsal–ventral | ±z | D / V | Blue `#3a7bd5` | `2` |
| Left–right | ±y | L / R | Green `#2e9e5b` | `3` |

### Building each axis

1. Create one `Group` per pair under `flyRoot`.
2. Add a thin `CylinderGeometry` shaft through the origin and a `ConeGeometry` head at each end. Rotate them so the default cylinder axis (+y) lies on the pair's vector.
3. Size from the bounding box: half-length = 0.65 × the fly's extent along that axis, with a minimum so the short L–R axis stays readable. Shaft radius about 0.01 × body length.
4. Add a `CSS2DObject` label just past each tip, showing the full word on hover ("Anterior") and the letter otherwise.
5. Use `MeshBasicMaterial` (unlit) with `depthTest: false` and a high `renderOrder`, so axes stay visible through the body. Offer an "Axes behind body" option that turns `depthTest` back on.

**Origin.** Default to the centre of the fly's bounding box, so all three axes cross in the middle of the body. Offer a dropdown for "Thorax origin", the model's root at the neck–thorax junction, which is what flygym reports positions against.

**Toggles.** One checkbox per pair plus "All axes" (`A` key). Persist the state in the URL hash, for example `#axes=ap,dv`. When an axis is hidden, also hide its labels, because `CSS2DObject` visibility does not inherit automatically in older three.js versions. *Verified in M4:* in three r186, `CSS2DRenderer` hides the whole subtree of an invisible object, so hiding the axis group is enough.

### Position aids

These cover the "bodily position" part of the brief, so the user always knows where they are on the fly.

- **Orientation gizmo.** A small labelled cube or axis tripod in the bottom-left corner, rendered in a second scene with its own camera. Each frame, copy the main camera's quaternion relative to `flyRoot`. It stays readable when zoomed in so far that the main axes are off-screen. Clicking a face triggers the matching view preset.
- **Anatomical planes (optional toggle).** Semi-transparent quads for the sagittal (x–z), horizontal (x–y) and transverse (y–z) planes through the origin, off by default.
- **Hover readout.** Raycast on pointer move and show the segment name ("left front tibia", mapped from `lf_tibia`) and the hit point in fly coordinates, in millimetres, from the chosen origin. Convert the world-space hit with `flyRoot.worldToLocal`, not the hit node's local frame (meshopt quantisation gives every node its own transform). Throttle to one raycast per animation frame.

## Repo layout, milestones and checks

### Repo layout

```text
fly-viewer/
├── tools/
│   ├── bake_fly.py          # flygym → MuJoCo FK → fly.glb + fly.meta.json
│   ├── fetch_flygym.sh      # sparse checkout of flygym at the pinned commit
│   └── requirements.txt     # exact pins: flygym 2.1.0, mujoco 3.9.0, trimesh, numpy, pyyaml
├── public/
│   ├── fly.glb              # committed build artefact (~1 MB)
│   └── fly.meta.json
├── src/
│   ├── main.js  loadFly.js  camera.js  axes.js
│   ├── gizmo.js  picking.js  ui.js
│   └── style.css
├── index.html
├── package.json             # exact versions: three, vite, @gltf-transform/cli
├── LICENSE                  # Apache-2.0, same as flygym
├── NOTICE                   # credits NeuroMechFly meshes
└── .github/workflows/pages.yml
```

Commit the baked GLB so contributors without Python can work on the viewer. Re-bake only when the flygym pin changes.

### Milestones

1. **M0 – Assets.** Sparse-checkout flygym at the pinned commit and confirm the 39 STLs and `rigging.yaml` load. *Done when* a throwaway script lists 69 segments with parents.
2. **M1 – Bake.** Write `bake_fly.py`. *Done when* `fly.glb` opens in gltf.report with 69 named nodes, legs in the neutral pose, nothing inside-out, under 1.5 MB.
3. **M2 – Static viewer.** Vite app that loads the GLB, Y-up rotation, lights, fit-to-view. *Done when* the fly appears upright, head to the right, on desktop Chrome, Firefox, Safari and mobile.
4. **M3 – Camera.** Orbit, zoom-to-cursor, pan, reset, six view presets, URL-hash state. *Done when* every preset shows the stated side and a copied URL restores the same view.
5. **M4 – Axes.** A–P, D–V, L–R arrows with labels and independent toggles. *Done when* in Dorsal view the A arrow points at the head, L points to the fly's left wing, and D points at the viewer.
6. **M5 – Position aids.** Corner gizmo, hover readout, optional planes. *Done when* hovering the left front tibia reads "left front tibia" with a negative z coordinate from the Thorax origin. (From the default body-centre origin only its lower part is negative: in the neutral pose the tibia spans z −0.28 to +0.18 mm relative to the body centre, and −0.76 to −0.30 mm relative to the thorax.)
7. **M6 – Ship.** GitHub Pages deploy, README with screenshots, NOTICE and citation. Lighthouse performance score above 90.

Later extensions: full-resolution meshes, the flight pose, a joint-angle slider panel driven by MuJoCo WASM, and the FlyBody model.

### Pitfalls

- **Left vs right.** +y is the fly's own left, which appears on the viewer's right in a ventral view. Test with the asymmetric check in M4, not by eye.
- **Inside-out right side** from negative-scale mirroring. MuJoCo handles it in the bake (asserted); the browser-only fallback must reverse triangle order itself.
- **Raw STL vs MuJoCo vertices.** In the bake, use `model.mesh_vert` with the geom pose. Raw STL vertices with the geom pose would be offset, because MuJoCo recentres meshes.
- **Quaternion order** (w, x, y, z) in YAML vs (x, y, z, w) in three.js.
- **Units.** STL in metres, everything else in mm. A fly that is invisible or fills the screen is usually a 1000× mistake.
- **Clipping planes** too wide for a 3 mm object cause z-fighting. Keep near/far at 0.01 / 100 mm.
- **Transparent wings** sorting badly against axes. Set wings' `renderOrder` below the axes, *and* put the axis materials in the transparent pass (`transparent: true`, opacity 1): three.js renders all opaque objects before any transparent one regardless of `renderOrder`, so opaque axes get blended over by the wings.
- **Pin versions** of three.js and flygym; three.js addon import paths change between releases.

### References

- [flygym repository](https://github.com/NeLy-EPFL/flygym) and [NeuroMechFly documentation](https://neuromechfly.org)
- Lobato-Rios et al., "NeuroMechFly, a neuromechanical model of adult *Drosophila melanogaster*", *Nature Methods* 2022; Wang-Chen et al., "NeuroMechFly v2", *Nature Methods* 2024. Cite both in the README; check the flygym docs for their current preferred citation.
- [three.js manual](https://threejs.org/manual/) and examples for `OrbitControls`, `TrackballControls`, `GLTFLoader`, `CSS2DRenderer`
- [glTF-Transform](https://gltf-transform.dev) for optimisation
- [MuJoCo Python bindings](https://mujoco.readthedocs.io/en/stable/python.html) for `mj_kinematics`, `mesh_vert`, `geom_xmat`
