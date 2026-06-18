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

### Broadcast (`project_id`) — no wires needed
Every consumer (Extract / Preview / Router Slave) can read the project two ways:
1. **Wired** — connect the hub's `PROJECT_LOGIC` output to the consumer's `project`
   input (takes precedence).
2. **Broadcast** — set the consumer's `project_id` to match a hub's `project_id`.
   The JS layer mirrors the hub's config into the consumer, which rebuilds the
   bundle locally at run time. No noodle required.

### Project Logic (hub)
Inputs: `project_id`, `project_path`, `shot` (dropdown of subfolders), `plate_clip`
(dropdown of detected sequences/movies), `global_seed`, `default_template`,
`output_template`, and a dynamic **pass-line editor** (type / ext / kind /
own-subfolder / optional per-line template; add/remove lines; `custom` reveals a
free-text type; type list includes `PlateA/B/C`). Outputs a `PROJECT_LOGIC` bundle
and broadcasts its config on `project_id`.

### Project Logic Extract
`pass_name` is a dropdown **auto-filled with the project's configured passes**
(plus `output`/`plate`). Source the project via a wired `project` or a `project_id`.
Outputs: `full_path` (loader-ready, incl. ext), `pathtofile` (folder), `file`
(saver-ready filename — no ext, keeps `####`), `framecount`, `seed`.

* CoCo **SaverNode**: `pathtofile` → `file_path`, `file` → `filename` (set the
  saver's `file_type` to your pass ext).
* CoCo **EXR sequence loader**: `full_path` → `sequence_path`.

### Project Logic Router Master / Router Slave
A wireless "active pass" router so one dropdown reroutes the whole graph.

* **Router Master** — pick the active pass type for a `router_id`. `active` is a
  dropdown of the project's passes. No output noodles. Different `router_id` values
  drive independent router groups.
* **Router Slave** — a mux whose `ANY` input slots are **auto-populated and labelled
  from the project's passes** (via `project_id` or a wired bundle); no manual slot
  config. `router_id` is a dropdown of the masters in the graph. It outputs the input
  matching the master's active type, and **draws a link from the active input to the
  output** so the live route is visible at a glance.

### Project Logic Preview
Shows the resolved bundle (seq path / dir / file / frame count per pass) **inline on
the node** after a run — no separate Display node needed.

## Notes
- Shot/plate dropdowns are populated by two read-only server routes
  (`/projectlogic/subfolders`, `/projectlogic/sequences`). Without the JS layer the
  fields still work as plain text entry.
- `framecount` is a count only (globs the `####` pattern); no start/end range.
- Only one Project Logic (hub) node is active per workflow. The first one is the
  primary; any extra hub node is bypassed, veiled with a warning, and excluded from
  the broadcast.
