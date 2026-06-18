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

### Project Logic (hub)
Inputs: `project_path`, `shot` (dropdown of subfolders), `plate_clip` (dropdown of
detected sequences/movies in the shot folder), `seed`, `default_template`,
`output_template`, and a dynamic **pass-line editor** (type / ext / kind /
own-subfolder / optional per-line template; add/remove lines; `custom` reveals a
free-text type). Outputs a single `PROJECT_LOGIC` bundle.

### Project Logic Extract
Takes the `PROJECT_LOGIC` bundle and a `pass_name` dropdown (any common type plus
`plate`, `output`, `custom`). Outputs `directory`, `filename`, `sequence_path`,
`ext`, `frame_count` — wire only what each downstream node needs:

* CoCo **SaverNode**: `directory` → `file_path`, `filename` → `filename`
  (filename has **no** extension, so set the saver's `file_type` to `ext`).
* CoCo **EXR sequence loader**: `sequence_path` → `sequence_path`.
* `frame_count` → any INT input.

Unknown / custom pass names are computed on the fly from the default template, so
arbitrary passes work without pre-declaring them.

### Project Logic Path Split
Generic helper: any path string → `directory`, `filename` (no ext), `filename_ext`,
`ext`, `frame_count`. Handy right before a saver when feeding a raw path.

## Notes
- The shot/plate dropdowns are populated by two read-only server routes
  (`/projectlogic/subfolders`, `/projectlogic/sequences`). Without the JS layer the
  fields still work as plain text entry.
- `frame_count` is a count only (globs the `####` pattern); no start/end range.
