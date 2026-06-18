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
with a popup). It has **no output noodle** and consumers have **no project input** —
Extract / Preview read the hub's settings straight from the submitted **prompt** at run
time, and the router reads the hub's pass list in the editor. Nothing to wire.

### Project Logic (hub)
Inputs: `project_path`, `shot` (dropdown of subfolders), `plate_clip` (dropdown of
detected image sequences/movies), `global_seed` (with the fixed/increment/randomize
control), `default_template`, `output_template`, and a dynamic **pass-line editor**
(type / ext / kind / own-subfolder / optional per-line template; add/remove lines;
`custom` reveals a free-text type; type list includes `PlateA/B/C`).

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
* **Router Slave** — a mux whose `ANY` input slots **are the project's pass types**
  (each slot is named after a pass); no manual slot config. `router_id` is a dropdown of
  the masters in the graph. Outputs the input matching the master's active type, and
  **draws a link from the active input to the output** so the live route is visible at a
  glance. Adding a slave with no master present **auto-creates a master**; if none is
  available the `router_id` shows **NaN in red**. Renaming a master's `router_id`
  **carries its slaves along** so the routing doesn't break.

### Project Logic Preview
Shows the resolved bundle (seq path / dir / file / frame count per pass) **inline on
the node** after a run — no separate Display node needed.

## Notes
- Shot/plate dropdowns are populated by two read-only server routes
  (`/projectlogic/subfolders`, `/projectlogic/sequences`). Scans run on UI reload, the
  single **↻ rescan** button, and ~600ms after a path edit settles (not live). Plate
  scanning only lists real image-sequence and movie formats.
- `project_path` may be **typed or wired** from a string/primitive node. When wired, the
  value is resolved by tracing the link upstream (through reroutes) to the source node's
  widget — both in the editor (to drive the dropdowns, and reflected back into the
  widget) and at run time (read from the prompt) so paths stay correct.
- `framecount` is a count only (globs the `####` pattern); no start/end range.
