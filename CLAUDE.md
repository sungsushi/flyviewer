# flyviewer

Browser-based 3D viewer of an adult *Drosophila melanogaster* (NeuroMechFly meshes from flygym, baked to one GLB, rendered with three.js).

**`docs/PLAN.md` is the source of truth** for assets, coordinate conventions, architecture and milestones. Read it before working.

## Working rules

- **One milestone at a time** (M0 → M6 in PLAN.md). At the end of each: stop, summarise what was done, explain how to verify it, and wait for the user's go-ahead before starting the next.
- **Before writing code for a milestone**, briefly list the files to be created or changed.
- **Pin versions exactly, no ranges:**
  - `flygym==2.1.0`, source pinned at commit `38c8ec61034cd59bc5ba0de20688d4a3c0000d60`
  - `mujoco` at the exact version flygym 2.1.0 resolves to (`3.9.0`)
  - exact `three` and `vite` versions in `package.json`
- **Keep it minimal:** plain three.js + Vite, no UI framework, no extra dependencies without asking first.
- **If PLAN.md is wrong or unverifiable**, don't silently work around it. Report what was found, then propose a fix.
- Verify claims against flygym's actual source (`vendor/flygym/`, or the installed package in `.venv/`), not against the plan.

## Local setup

- `tools/fetch_flygym.sh`: sparse checkout of flygym at the pinned commit into `vendor/flygym/` (gitignored)
- `.venv/`: Python 3.12 venv with `pip install -r tools/requirements.txt` (gitignored)
- `npm ci`: three, vite and the glTF-Transform CLI used by the bake (all exact pins; `.npmrc` sets `save-exact`)
- Bake: `.venv/bin/python -I tools/bake_fly.py` → `public/fly.glb`, `public/fly.meta.json` (committed)
- Dev server: `npm run dev`; production build: `npm run build` (relative `base`, works under any Pages path)
- Deploy: `.github/workflows/pages.yml` on push to `main` (Pages source: GitHub Actions); actions pinned to commit SHAs
- The PyPI `flygym==2.1.0` wheel's `assets/`, `anatomy.py` and `compose/` are byte-identical to the pinned commit (checked in M0).

## Conventions (summary; details in PLAN.md)

- Fly frame: right-handed, Z-up, millimetres. +x anterior, +y fly's **left**, +z dorsal.
- The viewer keeps the fly in its native frame under `flyRoot` and rotates once: `flyRoot.rotation.x = -Math.PI / 2`.
- Quaternions in `rigging.yaml` are (w, x, y, z); three.js is (x, y, z, w).
