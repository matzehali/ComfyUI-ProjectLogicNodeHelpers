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
  "PlateA", "PlateB", "PlateC",
  "custom", "none",
];
const EXT_OPTIONS = ["exr", "png", "jpg", "tiff", "webp", "mov", "mp4"];
const KIND_OPTIONS = ["sequence", "movie"];

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

// Effective path: typed widget value, or the wired upstream string. When wired,
// reflect the resolved value back into the widget so it shows the real input.
function projectPath(node) {
  const v = fieldValue(node, "project_path") || "";
  const inSlot = node.inputs?.find((i) => i.name === "project_path");
  if (inSlot && inSlot.link != null) {
    const w = getWidget(node, "project_path");
    if (w && w.value !== v) w.value = v;
  }
  return v;
}

async function refreshShots(node) {
  const shotW = getWidget(node, "shot");
  if (!shotW) return;
  const token = (node._plShotReq = (node._plShotReq || 0) + 1);
  const data = await fetchJSON(
    `/projectlogic/subfolders?path=${encodeURIComponent(projectPath(node))}`,
  );
  if (token !== node._plShotReq) return; // a newer scan superseded this one
  asCombo(shotW, data?.folders || []);
  notifyChange();
  node.setDirtyCanvas?.(true, true);
}

async function refreshPlates(node) {
  const shotW = getWidget(node, "shot");
  const plateW = getWidget(node, "plate_clip");
  if (!shotW || !plateW) return;
  const root = projectPath(node).replace(/[\\/]+$/, "");
  const shotDir = root && shotW.value ? `${root}/${shotW.value}` : root;
  const token = (node._plPlateReq = (node._plPlateReq || 0) + 1);
  const data = await fetchJSON(
    `/projectlogic/sequences?path=${encodeURIComponent(shotDir)}`,
  );
  if (token !== node._plPlateReq) return;
  asCombo(plateW, ["", ...(data?.sequences || [])]);
  notifyChange();
  node.setDirtyCanvas?.(true, true);
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

  // Path edits are debounced so the scan fires only once typing settles.
  const debouncedScan = debounce(
    () => refreshShots(node).then(() => refreshPlates(node)),
    600,
  );

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

  // Wiring (or unwiring) the path input re-resolves and re-scans.
  const occ = node.onConnectionsChange;
  node.onConnectionsChange = function () {
    occ?.apply(this, arguments);
    setTimeout(() => {
      hookUpstream();
      notifyChange();
      debouncedScan();
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
      notifyChange();
    };
  }

  node.addWidget("button", "↻ rescan", null, () =>
    refreshShots(node).then(() => refreshPlates(node)),
  );

  const doRefresh = () => {
    hookUpstream();
    return refreshShots(node).then(() => refreshPlates(node));
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

  let rows;
  try {
    rows = JSON.parse(passesW.value || "[]");
    if (!Array.isArray(rows)) rows = [];
  } catch (e) {
    rows = [];
  }
  rows = rows.map((r) => Object.assign(blankRow(), r));
  rows = normalizeRows(rows);

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
          commit();
        }),
      );

      line.appendChild(
        makeSelect(KIND_OPTIONS, row.kind, (v) => {
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
}

// --------------------------------------------------------------------------- //
// Consumers (Extract / Preview): config comes from the PROMPT at run time, so
// the only edit-time job is the pass_name dropdown (Extract).
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
