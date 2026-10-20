"""Bake the NeuroMechFly neutral pose into one GLB for the browser viewer.

flygym (pinned) builds the MuJoCo model; MuJoCo does the forward kinematics. Every
mesh geom is transformed into the fly frame (right-handed, Z-up, mm; +x anterior,
+y fly's left, +z dorsal) and written as one named node per body segment.

Usage (from repo root):
    .venv/bin/python -I tools/bake_fly.py

Outputs:
    build/fly_raw.glb       uncompressed, for inspection
    public/fly.glb          meshopt-compressed (glTF-Transform, pinned in package.json;
                            run `npm ci` first)
    public/fly.meta.json    bounds, body length, thorax origin, provenance
"""

import fnmatch
import json
import struct
import subprocess
import warnings
from importlib.metadata import version
from pathlib import Path

import mujoco as mj
import numpy as np
import trimesh
import yaml
from flygym import assets_dir
from flygym.anatomy import ALL_CONNECTED_SEGMENT_PAIRS, AxisOrder, JointPreset, Skeleton
from flygym.compose import KinematicPosePreset, NeuroMechFly

FLYGYM_COMMIT = "38c8ec61034cd59bc5ba0de20688d4a3c0000d60"
# Same as flygym tutorial 1a, and the order the neutral pose was authored in
# (pose/_manual_specs/neutral.yaml). The other five axis-order files are conversions
# rounded to whole degrees, which moves leg tips by up to ~80 µm; the bake reports it.
AXIS_ORDER = AxisOrder.ROLL_PITCH_YAW
JOINT_PRESET = JointPreset.ALL_BIOLOGICAL

ROOT = Path(__file__).resolve().parent.parent
RAW_GLB = ROOT / "build/fly_raw.glb"
OUT_GLB = ROOT / "public/fly.glb"
OUT_META = ROOT / "public/fly.meta.json"
VISUALS_YAML = assets_dir / "model/neuromechfly/visuals.yaml"


def posed_model(axis_order: AxisOrder) -> tuple[mj.MjModel, mj.MjData]:
    """Compile NeuroMechFly with joints and run FK at the `neutral` keyframe."""
    fly = NeuroMechFly()
    skeleton = Skeleton(axis_order=axis_order, joint_preset=JOINT_PRESET)
    fly.add_joints(skeleton, neutral_pose=KinematicPosePreset.NEUTRAL)
    with warnings.catch_warnings():  # standalone compile warns about fusestatic
        warnings.simplefilter("ignore")
        model, data = fly.compile()
    mj.mj_resetDataKeyframe(model, data, mj.mj_name2id(model, mj.mjtObj.mjOBJ_KEY, "neutral"))
    mj.mj_kinematics(model, data)
    return model, data


def world_meshes(model: mj.MjModel, data: mj.MjData) -> dict[str, tuple[np.ndarray, np.ndarray]]:
    """Segment name -> (vertices in fly frame [mm], faces), from MuJoCo's own arrays.

    MuJoCo recentres/reorients each mesh and stores the offset in the geom pose,
    so the raw STL must not be used here.
    """
    out = {}
    for g in range(model.ngeom):
        if model.geom_type[g] != mj.mjtGeom.mjGEOM_MESH:
            continue
        m = model.geom_dataid[g]
        va, vn = model.mesh_vertadr[m], model.mesh_vertnum[m]
        fa, fn = model.mesh_faceadr[m], model.mesh_facenum[m]
        R = data.geom_xmat[g].reshape(3, 3)
        assert np.linalg.det(R) > 0, f"geom {g}: improper rotation"
        verts = model.mesh_vert[va : va + vn].astype(np.float64) @ R.T + data.geom_xpos[g]
        faces = model.mesh_face[fa : fa + fn].astype(np.int64)
        name = model.body(model.geom_bodyid[g]).name
        assert name not in out, f"duplicate segment {name}"
        out[name] = (verts, faces)
    return out


def signed_volume(verts: np.ndarray, faces: np.ndarray) -> float:
    a, b, c = verts[faces[:, 0]], verts[faces[:, 1]], verts[faces[:, 2]]
    return float(np.einsum("ij,ij->i", a, np.cross(b, c)).sum() / 6)


def srgb_to_linear(c: np.ndarray) -> np.ndarray:
    c = np.asarray(c, dtype=np.float64)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def materials_by_segment(segments: list[str]) -> dict[str, trimesh.visual.material.PBRMaterial]:
    """One glTF material per visuals.yaml set, matched exactly once per segment.

    visuals.yaml mostly sets rgba = [1,1,1,a] and puts the colour in a procedural
    texture (rgb1, plus rgb2 for gradients). We bake a flat colour:
    rgba.rgb * (rgb1 for 'flat', mean(rgb1, rgb2) for 'gradient'). Random speckle
    marks are dropped. MuJoCo colours are display (sRGB) values; glTF base colour
    factors are linear, so convert.
    """
    vis = yaml.safe_load(VISUALS_YAML.read_text())
    mats, owner = {}, {}
    for set_name, params in vis.items():
        mat = params["material"]
        rgba = np.array(mat.get("rgba", [1, 1, 1, 1]), dtype=np.float64)
        rgb = rgba[:3]
        if tex := params.get("texture"):
            rgb1 = np.array(tex["rgb1"], dtype=np.float64)
            if tex.get("builtin", "flat") == "gradient":
                rgb1 = (rgb1 + np.array(tex["rgb2"], dtype=np.float64)) / 2
            rgb = rgb * rgb1
        alpha = float(rgba[3])
        mats[set_name] = trimesh.visual.material.PBRMaterial(
            name=set_name,
            baseColorFactor=[*srgb_to_linear(rgb), alpha],
            metallicFactor=0.0,
            roughnessFactor=float(1.0 - mat.get("shininess", 0.5)),
            alphaMode="BLEND" if alpha < 1 else "OPAQUE",
            doubleSided=alpha < 1,  # see the far surface of thin translucent wings
        )
        patterns = params["apply_to"]
        for pattern in [patterns] if isinstance(patterns, str) else patterns:
            for seg in fnmatch.filter(segments, pattern):
                assert seg not in owner, f"{seg}: matched by {owner[seg]} and {set_name}"
                owner[seg] = set_name
    missing = set(segments) - set(owner)
    assert not missing, f"no visuals set for {sorted(missing)}"
    return {seg: mats[owner[seg]] for seg in segments}


def main() -> None:
    model, data = posed_model(AXIS_ORDER)
    meshes = world_meshes(model, data)
    segments = list(meshes)
    assert len(segments) == 69, len(segments)

    # The six axis-order variants of the neutral pose should give the same posture.
    worst = 0.0
    for order in AxisOrder:  # iteration skips aliases (PRY, DONTCARE, ...)
        other = world_meshes(*posed_model(order))
        worst = max(worst, max(np.abs(other[s][0] - meshes[s][0]).max() for s in segments))
    print(f"max vertex deviation of other axis-order pose files: {worst * 1000:.1f} µm")

    # Winding: every closed mesh must have positive signed volume (outward CCW faces).
    # MuJoCo already reverses face order for meshes with negative-determinant scale
    # (the mirrored r_* parts); flip here only if that ever stops being true.
    flipped = []
    for seg, (v, f) in meshes.items():
        if signed_volume(v, f) < 0:
            meshes[seg] = (v, f[:, ::-1].copy())
            flipped.append(seg)
    print(f"meshes with inverted winding (fixed): {flipped or 'none'}")
    for seg in segments:
        if seg.startswith("r"):
            l_vol, r_vol = (signed_volume(*meshes[s]) for s in ("l" + seg[1:], seg))
            assert np.isclose(l_vol, r_vol, rtol=1e-6), (seg, l_vol, r_vol)

    materials = materials_by_segment(segments)
    scene = trimesh.Scene()
    for seg in segments:
        v, f = meshes[seg]
        tm = trimesh.Trimesh(vertices=v, faces=f, process=False)
        tm.visual = trimesh.visual.TextureVisuals(material=materials[seg])
        scene.add_geometry(tm, geom_name=seg, node_name=seg)

    RAW_GLB.parent.mkdir(exist_ok=True)
    RAW_GLB.write_bytes(scene.export(file_type="glb", include_normals=True))

    # Lossless except for meshopt quantisation. The CLI defaults would also simplify
    # meshes, merge materials into a palette texture and join/flatten nodes.
    subprocess.run(
        [
            "npm", "exec", "--no", "--", "gltf-transform", "optimize", str(RAW_GLB), str(OUT_GLB),
            "--compress", "meshopt",
            "--simplify", "false", "--palette", "false", "--join", "false",
            "--flatten", "false", "--instance", "false",
        ],
        check=True,
        cwd=ROOT,
    )

    # The optimised file must keep 69 flat, segment-named nodes and stay small.
    glb = OUT_GLB.read_bytes()
    gltf = json.loads(glb[20 : 20 + struct.unpack("<I", glb[12:16])[0]])
    assert sorted(n["name"] for n in gltf["nodes"]) == sorted(segments)
    assert len(gltf["scenes"][0]["nodes"]) == 69, "nodes were nested or joined"
    assert len(glb) < 1.5e6, f"{OUT_GLB.name} is {len(glb) / 1e6:.2f} MB"

    all_v = np.concatenate([v for v, _ in meshes.values()])
    bb_min, bb_max = all_v.min(0), all_v.max(0)
    central = np.concatenate([meshes[s][0] for s in segments if s.startswith("c_")])
    parent_of = {c: p for p, c in ALL_CONNECTED_SEGMENT_PAIRS}
    meta = {
        "units": "mm",
        "frame": "right-handed, Z-up; +x anterior, +y fly's left, +z dorsal",
        "pose": f"flygym KinematicPosePreset.NEUTRAL ({AXIS_ORDER.to_str()}, "
                f"{JOINT_PRESET.value})",
        "bbox": {"min": bb_min.round(4).tolist(), "max": bb_max.round(4).tolist()},
        "bodyLength": round(float(np.ptp(central[:, 0])), 4),
        "bodyLengthDefinition": "x-extent of central (c_*) segments: proboscis to abdomen tip",
        "thoraxOrigin": data.xpos[model.body("c_thorax").id].round(4).tolist(),
        "segments": {s: parent_of.get(s) for s in segments},
        "source": {
            "flygym": version("flygym"),
            "flygymCommit": FLYGYM_COMMIT,
            "mujoco": mj.__version__,
            "license": "Apache-2.0",
            "credit": "NeuroMechFly (Lobato-Rios et al. 2022; Wang-Chen et al. 2024)",
        },
    }
    OUT_META.write_text(json.dumps(meta, indent=2) + "\n")

    print(f"segments: {len(segments)}  triangles: {sum(len(f) for _, f in meshes.values())}")
    print(f"bbox min {bb_min.round(3)} max {bb_max.round(3)} mm; body length "
          f"{meta['bodyLength']} mm")
    print(f"{RAW_GLB.relative_to(ROOT)}: {RAW_GLB.stat().st_size / 1e6:.2f} MB  "
          f"{OUT_GLB.relative_to(ROOT)}: {OUT_GLB.stat().st_size / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
