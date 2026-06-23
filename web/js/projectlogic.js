import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import {
  getWidget,
  hideWidget,
  asCombo,
  comboFromFn,
  consumerTypes,
  notifyChange,
  fieldValue,
  upstreamSourceNode,
} from "./projectlogic_shared.js";

// --------------------------------------------------------------------------- //
// Vocabularies (kept in sync with paths.py)
// --------------------------------------------------------------------------- //
const TYPE_OPTIONS = [
  "base", "mask", "depthmap", "normals", "motion",
  "matte", "beauty", "cryptomatte",
  "firstframe", "middleframe", "lastframe",
  "PlateA", "PlateB", "PlateC",
  "custom", "none",
];
const EXT_OPTIONS = ["exr", "png", "jpg", "tiff", "webp", "mov", "mp4"];
const MOVIE_EXTS = new Set(["mov", "mp4", "mkv", "avi", "mxf", "m4v", "mpg", "mpeg", "webm"]);
const STILL_TYPES = new Set(["firstframe", "middleframe", "lastframe"]);

const isMovieExt = (ext) => MOVIE_EXTS.has(String(ext || "").toLowerCase());
// Valid kinds depend on the extension: movies are always "movie"; images can be
// a "sequence" (####) or a single "still".
const kindOptionsFor = (ext) => (isMovieExt(ext) ? ["movie"] : ["sequence", "still"]);

const CONFIG_FIELDS = [
  "project_path", "shot", "global_seed",
  "default_template", "output_template", "plate_clip",
];

// --------------------------------------------------------------------------- //
// Local DOM helpers
// --------------------------------------------------------------------------- //
async function fetchJSON(url) {
  try {
    const res = await api.fetchApi(url);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.warn("[projectlogic] fetch failed", url, e);
    return null;
  }
}

function makeSelect(options, value, onChange) {
  const sel = document.createElement("select");
  sel.style.cssText =
    "background:#222;color:#ddd;border:1px solid #444;border-radius:4px;font-size:11px;padding:1px 2px;";
  for (const opt of options) {
    const o = document.createElement("option");
    o.value = opt;
    o.textContent = opt;
    sel.appendChild(o);
  }
  if (value != null && !options.includes(value)) {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = value;
    sel.appendChild(o);
  }
  sel.value = value ?? options[0];
  sel.addEventListener("change", () => onChange(sel.value));
  return sel;
}

function makeInput(value, placeholder, onChange) {
  const inp = document.createElement("input");
  inp.type = "text";
  inp.value = value ?? "";
  inp.placeholder = placeholder ?? "";
  inp.style.cssText =
    "background:#222;color:#ddd;border:1px solid #444;border-radius:4px;font-size:11px;padding:1px 4px;min-width:0;";
  inp.addEventListener("change", () => onChange(inp.value));
  inp.addEventListener("input", () => onChange(inp.value));
  return inp;
}

// --------------------------------------------------------------------------- //
// Shot / plate dropdowns
//
// Scans run only on UI reload, on the manual buttons, and (debounced) once a
// path edit settles — never live per keystroke. Each scan carries a request
// token so a slow earlier response can't clobber the latest one.
// --------------------------------------------------------------------------- //
function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// Effective path used for scanning. The project_path widget is the single
// source of truth and is kept synced from any wired upstream by
// syncPathFromUpstream(). Reading the widget (not the live link) means a
// disconnect retains the last value instead of blanking the scan — which would
// otherwise wrongly clear shot/plate.
function projectPath(node) {
  const w = getWidget(node, "project_path");
  return (w && w.value) || "";
}

// Copy a wired upstream path into the project_path widget so it persists and
// stays visible. Returns true only when the value actually changed, so callers
// can rescan on a genuinely new path but skip a disconnect or a reconnect of the
// same path. A disconnected or not-yet-resolved input leaves the cached widget
// value untouched, so an accidental unplug doesn't trash the selection.
function syncPathFromUpstream(node) {
  const inSlot = node.inputs?.find((i) => i.name === "project_path");
  if (!inSlot || inSlot.link == null) return false; // disconnected: retain
  const v = fieldValue(node, "project_path") || "";
  if (!v) return false; // upstream not resolved yet: retain
  const w = getWidget(node, "project_path");
  if (w && w.value !== v) {
    w.value = v;
    return true; // a genuinely different path arrived
  }
  return false;
}

// Set a combo's options to a fresh scan; reset the selection if the current
// value no longer exists (so a stale shot/plate becomes unselected, not kept).
// The logical value of a combo: while busy the displayed value is the
// "scanning…" placeholder, so fall back to the stashed real selection. Any code
// that drives logic off a combo's value must read it through this.
function comboValue(w) {
  if (!w) return "";
  return w._plBusy ? (w._plPrevValue ?? "") : w.value;
}

function applyScan(w, values) {
  w.type = "combo";
  w.options = w.options || {};
  w.options.values = ["", ...values];
  // Restore the user's last explicit pick if the fresh scan still has it. The
  // pick is cached in _plDesired (set only when the user changes the dropdown,
  // see rememberPick), so a path that lacks it blanks the widget for now but
  // keeps the cache — a later scan that does contain it (path reconnected or
  // retyped by hand) restores the original selection. Fall back to the live
  // value before any pick has been remembered (e.g. a freshly loaded node).
  const desired = w._plDesired ?? comboValue(w);
  w.value = desired && values.includes(desired) ? desired : "";
}

// Cache the user's explicit dropdown pick so it survives a path change that
// hides it. Only a real user interaction reaches here (applyScan sets the value
// programmatically, which doesn't fire the callback), so this is the one place
// the cache is overwritten — exactly the "path changed, then dropdown changed"
// case. Ignored while busy, when the value is the transient scanning placeholder.
function rememberPick(w) {
  if (w && !w._plBusy) w._plDesired = w.value;
}

// Seed the cache from a freshly loaded selection so the first path change can
// already restore it. Never clobbers an in-session pick.
function seedDesired(w) {
  if (w && w._plDesired == null && w.value) w._plDesired = w.value;
}

function startResolving(node) {
  node._plResolving = (node._plResolving || 0) + 1;
  node.setDirtyCanvas?.(true, true);
}
function endResolving(node) {
  node._plResolving = Math.max(0, (node._plResolving || 1) - 1);
  node.setDirtyCanvas?.(true, true);
}

// While a combo is being (re)scanned, show "scanning…" in it and disable it so
// it can't be opened on stale options. applyScan() restores a real value; if no
// scan landed, clearing busy restores the prior selection.
const SCANNING_LABEL = "⏳ scanning…";
function setComboBusy(w, busy) {
  if (!w) return;
  if (busy) {
    if (!w._plBusy) {
      w._plBusy = true;
      w._plPrevValue = w.value;
      w.value = SCANNING_LABEL;
    }
    w.disabled = true;
  } else {
    if (w._plBusy && w.value === SCANNING_LABEL) w.value = w._plPrevValue ?? "";
    w._plBusy = false;
    w.disabled = false;
  }
}

async function refreshShots(node) {
  const shotW = getWidget(node, "shot");
  if (!shotW) return;
  const token = (node._plShotReq = (node._plShotReq || 0) + 1);
  startResolving(node);
  setComboBusy(shotW, true);
  try {
    const data = await fetchJSON(
      `/projectlogic/subfolders?path=${encodeURIComponent(projectPath(node))}`,
    );
    if (token !== node._plShotReq) return; // a newer scan superseded this one
    if (Array.isArray(data?.folders)) applyScan(shotW, data.folders);
    notifyChange();
  } finally {
    endResolving(node);
    // Leave the busy state to the newer scan if this one was superseded.
    if (token === node._plShotReq) setComboBusy(shotW, false);
  }
}

async function refreshPlates(node) {
  const shotW = getWidget(node, "shot");
  const plateW = getWidget(node, "plate_clip");
  if (!shotW || !plateW) return;
  const root = projectPath(node).replace(/[\\/]+$/, "");
  // Read the real shot, never the transient "scanning…" placeholder, so an
  // in-flight shot scan can't send this lookup to a bogus directory.
  const shot = comboValue(shotW);
  const shotDir = root && shot ? `${root}/${shot}` : root;
  const token = (node._plPlateReq = (node._plPlateReq || 0) + 1);
  startResolving(node);
  setComboBusy(plateW, true);
  try {
    const data = await fetchJSON(
      `/projectlogic/sequences?path=${encodeURIComponent(shotDir)}`,
    );
    if (token !== node._plPlateReq) return;
    if (Array.isArray(data?.sequences)) applyScan(plateW, data.sequences);
    notifyChange();
  } finally {
    endResolving(node);
    // Leave the busy state to the newer scan if this one was superseded.
    if (token === node._plPlateReq) setComboBusy(plateW, false);
  }
}

// A prominent "busy" badge across the node's title bar while folders are being
// scanned, so it's obvious the dropdowns aren't ready yet.
function installSpinner(node) {
  const prev = node.onDrawForeground;
  node.onDrawForeground = function (ctx) {
    prev?.apply(this, arguments);
    if (!this._plResolving || this.flags?.collapsed) return;

    const label = "scanning folders…";
    const r = 6; // spinner radius
    ctx.save();
    ctx.font = "11px sans-serif";
    const textW = ctx.measureText(label).width;
    const padX = 8;
    const gap = 7;
    const pillH = 20;
    const pillW = padX + r * 2 + gap + textW + padX;
    // Right side of the title bar, clear of the left-aligned node title.
    const px = this.size[0] - pillW - 6;
    const py = -pillH - 5;

    // Pill background.
    ctx.fillStyle = "rgba(20,28,38,0.92)";
    ctx.strokeStyle = "#66ccff";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(px, py, pillW, pillH, pillH / 2);
    ctx.fill();
    ctx.stroke();

    // Rotating arc.
    const a = (Date.now() / 130) % (Math.PI * 2);
    const cx = px + padX + r;
    const cy = py + pillH / 2;
    ctx.strokeStyle = "#9cf";
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.arc(cx, cy, r, a, a + Math.PI * 1.4);
    ctx.stroke();

    // Label.
    ctx.fillStyle = "#cfeaff";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(label, cx + r + gap, cy + 0.5);
    ctx.restore();

    requestAnimationFrame(() => this.setDirtyCanvas?.(true, true));
  };
}

// --------------------------------------------------------------------------- //
// Single-project enforcement: only the first Project Logic node is active; any
// extras are bypassed, veiled, and excluded from the broadcast.
// --------------------------------------------------------------------------- //
function projectNodes() {
  return (app.graph?._nodes || []).filter((n) => n.comfyClass === "ProjectLogic");
}

function popup(msg) {
  console.warn("[projectlogic]", msg);
  try {
    if (app.ui?.dialog?.show) {
      app.ui.dialog.show(msg);
      return;
    }
  } catch (e) {
    /* dialog API not available */
  }
  alert(msg);
}

// Only one hub allowed: if this node is an extra, remove it.
function removeIfDuplicate(node) {
  const hubs = projectNodes().sort((a, b) => (a.id || 0) - (b.id || 0));
  if (hubs.length > 1 && node !== hubs[0]) {
    app.graph.remove(node);
    popup("Only one Project Logic node is allowed per workflow.");
    return true;
  }
  return false;
}

function setupProjectNode(node) {
  const projectW = getWidget(node, "project_path");
  const shotW = getWidget(node, "shot");
  const plateW = getWidget(node, "plate_clip");

  asCombo(shotW, []);
  asCombo(plateW, [""]);
  installSpinner(node);

  // ComfyUI hard-codes the INT "control_after_generate" widget to "fixed" and
  // never serializes it, so the seed would never advance between runs. Flip the
  // seed's linked control widget to "randomize" on creation; the user can still
  // switch it back to "fixed" for the session.
  const seedW = getWidget(node, "global_seed");
  const seedCtl = seedW?.linkedWidgets?.[0] || getWidget(node, "control_after_generate");
  if (seedCtl?.options?.values?.includes?.("randomize")) seedCtl.value = "randomize";

  const scanAll = () => refreshShots(node).then(() => refreshPlates(node));

  // Path edits are debounced so the scan fires only once typing settles. Sync
  // first so an upstream edit lands in the widget before the scan reads it.
  const debouncedScan = debounce(() => {
    syncPathFromUpstream(node);
    scanAll();
  }, 600);

  // When project_path is wired, watch the upstream source's widget so its edits
  // re-trigger a scan (and re-resolve on connect/disconnect).
  function hookUpstream() {
    const src = upstreamSourceNode(node, "project_path");
    if (!src) return;
    for (const w of src.widgets || []) {
      if (w._plPathHooked) continue;
      w._plPathHooked = true;
      const prev = w.callback;
      w.callback = function () {
        prev?.apply(this, arguments);
        notifyChange(); // keep config fresh immediately
        debouncedScan();     // rescan once edits settle
      };
    }
  }

  if (projectW) {
    const prev = projectW.callback;
    projectW.callback = function () {
      prev?.apply(this, arguments);
      debouncedScan();
    };
  }

  // Connecting a path feeds its value into the widget; rescan only when that
  // value actually changed. A disconnect or a reconnect of the same path keeps
  // the cached widget value, so shot/plate survive an accidental unplug.
  const occ = node.onConnectionsChange;
  node.onConnectionsChange = function () {
    occ?.apply(this, arguments);
    setTimeout(() => {
      hookUpstream();
      const changed = syncPathFromUpstream(node);
      notifyChange();
      if (changed) debouncedScan();
    }, 30);
  };
  // Picking a shot is a finished change -> rescan plates immediately.
  if (shotW) {
    const prev = shotW.callback;
    shotW.callback = function () {
      prev?.apply(this, arguments);
      refreshPlates(node);
    };
  }

  // Any config edit re-broadcasts to consumers.
  for (const f of CONFIG_FIELDS) {
    const w = getWidget(node, f);
    if (!w) continue;
    const prev = w.callback;
    w.callback = function () {
      prev?.apply(this, arguments);
      // A user pick on a combo overwrites its cached desire; from then on a path
      // change restores this value, not the previously cached one.
      if (f === "shot" || f === "plate_clip") rememberPick(w);
      notifyChange();
    };
  }

  node.addWidget("button", "↻ rescan", null, () => {
    syncPathFromUpstream(node);
    scanAll();
  });

  const doRefresh = () => {
    hookUpstream();
    syncPathFromUpstream(node);
    // Seed the dropdown caches from any loaded selection so the very first path
    // change can already restore them instead of losing the value.
    seedDesired(shotW);
    seedDesired(plateW);
    return scanAll();
  };
  setTimeout(doRefresh, 50);
  const onCfg = node.onConfigure;
  node.onConfigure = function () {
    onCfg?.apply(this, arguments);
    setTimeout(doRefresh, 80);
  };
}

// --------------------------------------------------------------------------- //
// Dynamic pass-line editor (backed by the passes_json hidden widget)
// --------------------------------------------------------------------------- //
function blankRow() {
  return { type: "none", custom: "", ext: "exr", kind: "sequence", own_subfolder: true, template: "" };
}

function normalizeRows(rows) {
  const cleaned = rows.filter((r) => r.type && r.type !== "none");
  cleaned.push(blankRow());
  return cleaned;
}

function buildPassEditor(node) {
  const passesW = getWidget(node, "passes_json");
  if (!passesW) return;
  hideWidget(passesW);

  let rows = [];

  // Parse the (hidden) passes_json widget into editor rows. Called again from
  // onConfigure: ComfyUI restores saved widget values *after* nodeCreated runs,
  // so without a reload the editor keeps the defaults captured here and would
  // overwrite the user's saved passes on the next edit.
  function loadRows() {
    let parsed;
    try {
      parsed = JSON.parse(passesW.value || "[]");
      if (!Array.isArray(parsed)) parsed = [];
    } catch (e) {
      parsed = [];
    }
    rows = normalizeRows(parsed.map((r) => Object.assign(blankRow(), r)));
  }

  loadRows();

  const container = document.createElement("div");
  container.style.cssText =
    "display:flex;flex-direction:column;gap:3px;padding:4px 2px;font-family:sans-serif;";

  let domWidget;

  function commit() {
    const out = rows.filter((r) => r.type && r.type !== "none");
    passesW.value = JSON.stringify(out);
    notifyChange();
  }

  function render() {
    rows = normalizeRows(rows);
    container.innerHTML = "";

    const header = document.createElement("div");
    header.textContent = "passes";
    header.style.cssText = "color:#888;font-size:10px;text-transform:uppercase;letter-spacing:1px;";
    container.appendChild(header);

    rows.forEach((row, idx) => {
      const isBlank = row.type === "none";
      const line = document.createElement("div");
      line.style.cssText =
        "display:grid;grid-template-columns:1.2fr 1.2fr 0.8fr 1fr auto auto;gap:3px;align-items:center;";

      const typeSel = makeSelect(TYPE_OPTIONS, row.type, (v) => {
        row.type = v;
        // firstframe/middleframe/lastframe default to still (image) / movie (mov ext).
        if (STILL_TYPES.has(v)) row.kind = isMovieExt(row.ext) ? "movie" : "still";
        commit();
        render();
      });
      line.appendChild(typeSel);

      if (row.type === "custom") {
        line.appendChild(
          makeInput(row.custom, "custom type", (v) => {
            row.custom = v;
            commit();
          }),
        );
      } else {
        line.appendChild(document.createElement("span"));
      }

      line.appendChild(
        makeSelect(EXT_OPTIONS, row.ext, (v) => {
          row.ext = v;
          if (isMovieExt(v)) {
            row.kind = "movie"; // movie ext -> always movie
          } else if (!["sequence", "still"].includes(row.kind)) {
            // image ext -> default sequence (still for the still-types)
            row.kind = STILL_TYPES.has(row.type) ? "still" : "sequence";
          }
          commit();
          render();
        }),
      );

      const kindOpts = kindOptionsFor(row.ext);
      if (!kindOpts.includes(row.kind)) row.kind = kindOpts[0];
      line.appendChild(
        makeSelect(kindOpts, row.kind, (v) => {
          row.kind = v;
          commit();
        }),
      );

      const chk = document.createElement("input");
      chk.type = "checkbox";
      chk.checked = !!row.own_subfolder;
      chk.title = "own subfolder";
      chk.addEventListener("change", () => {
        row.own_subfolder = chk.checked;
        commit();
      });
      line.appendChild(chk);

      const rm = document.createElement("button");
      rm.textContent = isBlank ? "+" : "×";
      rm.title = isBlank ? "add line" : "remove line";
      rm.style.cssText =
        "background:#333;color:#ccc;border:1px solid #555;border-radius:4px;cursor:pointer;width:20px;";
      rm.addEventListener("click", () => {
        if (isBlank) {
          row.type = TYPE_OPTIONS[0];
        } else {
          rows.splice(idx, 1);
        }
        commit();
        render();
      });
      line.appendChild(rm);

      container.appendChild(line);

      if (!isBlank) {
        const tmpl = makeInput(row.template, "template override (optional)", (v) => {
          row.template = v;
          commit();
        });
        const wrap = document.createElement("div");
        wrap.style.cssText = "display:grid;grid-template-columns:1fr;";
        wrap.appendChild(tmpl);
        container.appendChild(wrap);
      }
    });

    const h = Math.max(120, container.scrollHeight + 8);
    if (domWidget) domWidget.computeSize = () => [node.size[0], h];
    node.setDirtyCanvas?.(true, true);
  }

  domWidget = node.addDOMWidget("passes_editor", "div", container, {
    serialize: false,
    hideOnZoom: false,
  });

  commit();
  render();

  // ComfyUI restores the saved passes_json *after* this node was created, so
  // re-read it once configuration lands and repaint the editor — without an
  // extra commit, which would clobber the just-restored value.
  const onCfg = node.onConfigure;
  node.onConfigure = function () {
    onCfg?.apply(this, arguments);
    setTimeout(() => {
      loadRows();
      render();
    }, 0);
  };
}

// --------------------------------------------------------------------------- //
// Consumers (Extract / Constants / Preview): config comes from the PROMPT at
// run time, so the only edit-time job is the pass_name dropdown (Extract).
// --------------------------------------------------------------------------- //
function setupConsumer(node, withPassName) {
  if (withPassName) {
    comboFromFn(getWidget(node, "pass_name"), () => consumerTypes(node), "base");
  }
}

function setupPreview(node) {
  setupConsumer(node, false);

  const pre = document.createElement("pre");
  pre.style.cssText =
    "white-space:pre-wrap;word-break:break-all;font-size:10px;line-height:1.3;" +
    "color:#cdd;background:#1b1b1b;border:1px solid #333;border-radius:4px;" +
    "padding:6px;margin:0;overflow:auto;max-height:400px;";
  pre.textContent = "(run to preview)";

  const widget = node.addDOMWidget("preview_text", "div", pre, { serialize: false });
  widget.computeSize = () => [node.size[0], Math.min(400, Math.max(80, pre.scrollHeight + 14))];

  const prev = node.onExecuted;
  node.onExecuted = function (message) {
    prev?.apply(this, arguments);
    const t = message?.text;
    pre.textContent = (Array.isArray(t) ? t.join("") : t) || "(empty)";
    node.setSize?.(node.computeSize());
    node.setDirtyCanvas?.(true, true);
  };
}

// --------------------------------------------------------------------------- //
// Extension registration
// --------------------------------------------------------------------------- //
app.registerExtension({
  name: "projectlogic.ui",

  async nodeCreated(node) {
    try {
      if (node.comfyClass === "ProjectLogic") {
        setupProjectNode(node);
        buildPassEditor(node);
        // Defer so the node is in the graph; remove it if it's a 2nd hub.
        setTimeout(() => {
          if (!removeIfDuplicate(node)) notifyChange();
        }, 30);
      } else if (node.comfyClass === "ProjectLogicExtract") {
        setupConsumer(node, true);
      } else if (node.comfyClass === "ProjectLogicPreview") {
        setupPreview(node);
      }
    } catch (e) {
      console.error("[projectlogic] node setup failed", node.comfyClass, e);
    }
  },
});
