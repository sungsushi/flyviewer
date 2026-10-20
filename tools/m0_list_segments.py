"""M0 throwaway: list the 69 NeuroMechFly body segments with their parent.

Kinematic tree: flygym.anatomy.ALL_CONNECTED_SEGMENT_PAIRS (installed flygym==2.1.0).
Rigging and STLs: the sparse checkout at the pinned commit (vendor/flygym).

Usage: .venv/bin/python -I tools/m0_list_segments.py vendor/flygym
"""

import sys
from pathlib import Path

import numpy as np
import yaml
from flygym.anatomy import ALL_CONNECTED_SEGMENT_PAIRS, ALL_SEGMENT_NAMES

NMF = Path(sys.argv[1]) / "src/flygym/assets/model/neuromechfly"
MESH_DIR = NMF / "meshes/simplified_max2000faces"


def read_binary_stl(path: Path) -> np.ndarray:
    """Return triangle vertices, shape (n, 3, 3), in the file's units (metres)."""
    data = path.read_bytes()
    n = int.from_bytes(data[80:84], "little")
    assert len(data) == 84 + 50 * n, f"{path.name}: not a binary STL"
    rec = np.dtype([("normal", "<f4", 3), ("v", "<f4", (3, 3)), ("attr", "<u2")])
    return np.frombuffer(data, dtype=rec, count=n, offset=84)["v"]


def quat_wxyz_to_mat(q) -> np.ndarray:
    w, x, y, z = np.asarray(q, float) / np.linalg.norm(q)
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
        [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
        [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
    ])


# --- Kinematic tree ---------------------------------------------------------
parent_of = {child: parent for parent, child in ALL_CONNECTED_SEGMENT_PAIRS}
roots = [s for s in ALL_SEGMENT_NAMES if s not in parent_of]
assert roots == ["c_thorax"], roots
assert len(ALL_SEGMENT_NAMES) == 69, len(ALL_SEGMENT_NAMES)

# --- Rigging ----------------------------------------------------------------
rigging = yaml.safe_load((NMF / "rigging.yaml").read_text())
assert set(rigging) == set(ALL_SEGMENT_NAMES), set(rigging) ^ set(ALL_SEGMENT_NAMES)

# --- STLs (left + central only; right side mirrors the left in y) ------------
stl_files = sorted(MESH_DIR.glob("*.stl"))
stls = {p.stem: read_binary_stl(p) for p in stl_files}
assert len(stls) == 39, len(stls)

# Zero-pose world frames from parent-relative pos/quat (mm)
world = {}
for seg in ALL_SEGMENT_NAMES:  # parents always precede children in this order
    R_loc, p_loc = quat_wxyz_to_mat(rigging[seg]["quat"]), np.array(rigging[seg]["pos"])
    if seg in parent_of:
        R_par, p_par = world[parent_of[seg]]
        world[seg] = (R_par @ R_loc, p_par + R_par @ p_loc)
    else:
        world[seg] = (R_loc, p_loc)

# --- Print -------------------------------------------------------------------
print(f"{'#':>2}  {'segment':<20} {'parent':<20} {'mesh (mirror)':<24} {'tris':>5}  "
      f"{'world origin, zero pose (mm)':>30}")
print("-" * 108)
total_tris = 0
for i, seg in enumerate(ALL_SEGMENT_NAMES, 1):
    mirrored = seg.startswith("r")
    mesh = f"l{seg[1:]}" if mirrored else seg
    tris = len(stls[mesh])
    total_tris += tris
    x, y, z = world[seg][1]
    print(f"{i:>2}  {seg:<20} {parent_of.get(seg, '(root)'):<20} "
          f"{mesh + ('  (y -1)' if mirrored else ''):<24} {tris:>5}  "
          f"{x:>+9.3f} {y:>+9.3f} {z:>+9.3f}")

th = stls["c_thorax"].reshape(-1, 3)
print("-" * 108)
print(f"segments: {len(ALL_SEGMENT_NAMES)}   rigging entries: {len(rigging)}   "
      f"STL files: {len(stls)}   triangles (all 69 segments): {total_tris}")
print("c_thorax STL bounds, raw file units (metres): "
      f"min {th.min(0).round(5)}  max {th.max(0).round(5)}")
