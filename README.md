> Agents: read `AGENTS.md` before working in this repo.

# ComfyUI-ProjectLogicNodeHelpers

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
time. (The Router Master/Slave are independent of the hub — the master defines its own
switch values.) Nothing to wire.

### Project Logic Hub
Inputs: `project_path`, `shot` (dropdown of subfolders), `plate_clip` (dropdown of
detected image sequences/movies), `global_seed` (with the fixed/increment/randomize
control), `default_template`, `output_template`, and a dynamic **pass-line editor**
(type / ext / kind / own-subfolder / optional per-line template; add/remove lines;
`custom` reveals a free-text type; type list includes `PlateA/B/C`).

### Project Logic SelectPath
A **Browse…** button opens the native OS file/folder dialog (folder or file via
`mode`) and drops the chosen absolute path into the `path` widget, output as a
STRING — wire it into the hub's `project_path` (or anywhere). The dialog opens on
the **ComfyUI server host**, so it's meant for local use.

### Project Logic Extract
`pass_name` is a dropdown **auto-filled with the project's configured passes**
(plus `output`/`plate`). Outputs: `full_path` (loader-ready, incl. ext), `pathtofile`
(folder), `file` (saver-ready filename — no ext, keeps `####`), `framecount`, `seed`.

* CoCo **SaverNode**: `pathtofile` → `file_path`, `file` → `filename` (set the
  saver's `file_type` to your pass ext).
* CoCo **EXR sequence loader**: `full_path` → `sequence_path`.

### Project Logic Constants
Reads the same hub config as Extract and emits only workflow-wide values:
`global_frames` (derived from the plate/base length) and `seed`.

### Project Logic Router Master / Router Slave
A wireless switch so one dropdown reroutes the whole graph.

* **Router Master** — defines its **own ordered list of switch values** in a small
  **options editor** (e.g. `ON`/`OFF`, or several IC-LoRA names; a trailing blank line
  spawns a new one once filled) and picks the `active` one from that list. Its identity
  is the node's own **unique id**; `label` is a free, editable title (**duplicates are
  fine**). No output noodles.
* **Router Slave** — a mux whose `ANY` input slots **mirror the linked master's option
  list**, labelled and ordered to match (slot names stay input_N so links survive
  save/load). The **`master` dropdown** lists master titles (same-named masters shown as
  `title (id)`) and stores the master's **unique id**, so the link survives renames and
  never confuses two equally-named masters. Outputs the input matching the master's
  active value and **draws a link from the active input to the output**; with no master
  it shows a red "no Router Master" note. Renaming a master's title only updates the
  displayed name — the link (by id) is unchanged.

### Pack Noodles / Unpack Noodles
Carry several labelled noodles on a single wire — e.g. to route a whole group through
one Router Slave.

* **Pack Noodles** — auto-growing ANY inputs, each with a label (typed in the inline
  editor, or auto-filled from the connected source's type when `auto_label` is on).
  Outputs one `PL_GROUP`.
* **Unpack Noodles** — takes a `PL_GROUP` and exposes one output **per label**. Labels
  are read upstream at edit time (tracing back through reroutes and a Router Slave to the
  Pack node) so you can wire before running, and refreshed from the bundle after a run.

```
[Pack: color/alpha/depth] → group → [Router Slave] → group → [Unpack → color, alpha, depth]
```

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
- `framecount` is the project's **single base length**, read from the base clip
  (`plate_clip`, else the `base` pass) and used for **every** pass — because passes
  are created at the base length, they don't exist yet at setup. Sequences count
  their `####` files; a movie base is read via `ffprobe` (container `nb_frames`, fast;
  missing ffmpeg raises asking you to install it — `brew install ffmpeg` or
  `pip install static-ffmpeg`). Any model-length padding is done downstream with math
  nodes.
