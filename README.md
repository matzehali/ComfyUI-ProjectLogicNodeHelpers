# ComfyUI-projectlogic

Project/shot-driven path nodes for VFX workflows. Start a graph from one **hub
node** (project folder + shot + plate clip + seed + the passes you care about)
and pull any derived path, filename or frame count through **a single wire** into
read/write nodes (e.g. the CoCo EXR sequence loader and `SaverNode`).

Replaces the usual sprawl of `LoadImageWithFilename` → truncate → `JoinStringMulti`
/ `PrimitiveString` / find-and-replace string chains.

## Path convention

Default template (editable per node, and overridable per pass line):

```
{root}/{shot}/{shot}_{type}/{shot}_{type}.####.{ext}

/Volumes/.../VFX/GRD0040/GRD0040_base/GRD0040_base.####.exr
                         GRD0040_mask/GRD0040_mask.####.exr
                         GRD0040_depthmap/GRD0040_depthmap.####.exr
```

Tokens: `{root} {shot} {type} {ext} {seed}`. A literal `####` (any run of `#`) is
the frame-number padding; it is dropped for `movie` passes. The implicit
**`output`** pass always lands in its own subfolder and includes `{seed}`.

## Nodes

### One hub, no wires
There is exactly **one Project Logic hub** per workflow (a second one is auto-removed
with a popup). It has **no output noodle** — consumers (Extract / Preview / Router Slave)
read it purely by **broadcast**: the JS layer mirrors the hub's config into each
consumer, which rebuilds the bundle locally at run time. Nothing to wire.

### Project Logic (hub)
Inputs: `project_path`, `shot` (dropdown of subfolders), `plate_clip` (dropdown of
detected sequences/movies), `global_seed`, `default_template`, `output_template`, and a
dynamic **pass-line editor** (type / ext / kind / own-subfolder / optional per-line
template; add/remove lines; `custom` reveals a free-text type; type list includes
`PlateA/B/C`). Outputs a `PROJECT_LOGIC` bundle and broadcasts its config.

### Project Logic Extract
`pass_name` is a dropdown **auto-filled with the project's configured passes**
(plus `output`/`plate`). Outputs: `full_path` (loader-ready, incl. ext), `pathtofile`
(folder), `file` (saver-ready filename — no ext, keeps `####`), `framecount`, `seed`.

* CoCo **SaverNode**: `pathtofile` → `file_path`, `file` → `filename` (set the
  saver's `file_type` to your pass ext).
* CoCo **EXR sequence loader**: `full_path` → `sequence_path`.

### Project Logic Router Master / Router Slave
A wireless "active pass" router so one dropdown reroutes the whole graph.

* **Router Master** — pick the active pass type for a `router_id`. `active` is a
  dropdown of the project's passes. No output noodles. Different `router_id` values
  drive independent router groups.
* **Router Slave** — a mux whose `ANY` input slots are **auto-populated and labelled
  from the project's passes**; no manual slot config. `router_id` is a dropdown of the
  masters in the graph. Outputs the input matching the master's active type, and
  **draws a link from the active input to the output** so the live route is visible at
  a glance. Adding a slave when no master exists **auto-creates a master**.

### Project Logic Preview
Shows the resolved bundle (seq path / dir / file / frame count per pass) **inline on
the node** after a run — no separate Display node needed.

## Notes
- Shot/plate dropdowns are populated by two read-only server routes
  (`/projectlogic/subfolders`, `/projectlogic/sequences`). Scans run on UI reload,
  the manual ↻ buttons, and ~600ms after a path edit settles (not live).
- `project_path` may be **typed or wired** from a string/primitive node. When wired,
  the value is resolved by tracing the link upstream (through reroutes) to the source
  node's widget, and the dropdowns re-scan on connection/upstream changes. The
  resolved value is also folded into the broadcast config so consumers stay correct.
- `framecount` is a count only (globs the `####` pattern); no start/end range.
