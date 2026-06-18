import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

// --------------------------------------------------------------------------- //
// Vocabularies (kept in sync with paths.py)
// --------------------------------------------------------------------------- //
const TYPE_OPTIONS = [
  "base", "mask", "depthmap", "normals", "motion",
  "matte", "beauty", "cryptomatte", "custom", "none",
];
const EXT_OPTIONS = ["exr", "png", "jpg", "tiff", "webp", "mov", "mp4"];
const KIND_OPTIONS = ["sequence", "movie"];

// --------------------------------------------------------------------------- //
// Small helpers
// --------------------------------------------------------------------------- //
function getWidget(node, name) {
  return node.widgets?.find((w) => w.name === name);
}

function hideWidget(w) {
  if (!w) return;
  w.hidden = true;
  w.computeSize = () => [0, -4];
}

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
// Shot / plate dropdowns (in-place text -> combo conversion + refresh)
// --------------------------------------------------------------------------- //
function asCombo(w, values, keepCurrent = true) {
  if (!w) return;
  w.type = "combo";
  w.options = w.options || {};
  let list = Array.isArray(values) ? values.slice() : [];
  if (keepCurrent && w.value && !list.includes(w.value)) list.unshift(w.value);
  if (!list.length) list = [w.value || ""];
  w.options.values = list;
  if (!list.includes(w.value)) w.value = list[0];
}

async function refreshShots(node) {
  const projectW = getWidget(node, "project_path");
  const shotW = getWidget(node, "shot");
  if (!projectW || !shotW) return;
  const data = await fetchJSON(
    `/projectlogic/subfolders?path=${encodeURIComponent(projectW.value || "")}`,
  );
  asCombo(shotW, data?.folders || []);
  node.setDirtyCanvas?.(true, true);
}

async function refreshPlates(node) {
  const projectW = getWidget(node, "project_path");
  const shotW = getWidget(node, "shot");
  const plateW = getWidget(node, "plate_clip");
  if (!projectW || !shotW || !plateW) return;
  const root = (projectW.value || "").replace(/[\\/]+$/, "");
  const shotDir = root && shotW.value ? `${root}/${shotW.value}` : root;
  const data = await fetchJSON(
    `/projectlogic/sequences?path=${encodeURIComponent(shotDir)}`,
  );
  asCombo(plateW, ["", ...(data?.sequences || [])]);
  node.setDirtyCanvas?.(true, true);
}

function hookRefresh(node) {
  const projectW = getWidget(node, "project_path");
  const shotW = getWidget(node, "shot");
  if (projectW) {
    const prev = projectW.callback;
    projectW.callback = function () {
      prev?.apply(this, arguments);
      refreshShots(node).then(() => refreshPlates(node));
    };
  }
  if (shotW) {
    const prev = shotW.callback;
    shotW.callback = function () {
      prev?.apply(this, arguments);
      refreshPlates(node);
    };
  }
  // Manual refresh buttons.
  node.addWidget("button", "↻ scan shots", null, () => refreshShots(node));
  node.addWidget("button", "↻ scan plate clips", null, () => refreshPlates(node));
}

// --------------------------------------------------------------------------- //
// Dynamic pass-line editor (backed by the passes_json hidden widget)
// --------------------------------------------------------------------------- //
function blankRow() {
  return { type: "none", custom: "", ext: "exr", kind: "sequence", own_subfolder: true, template: "" };
}

function normalizeRows(rows) {
  // Keep only real rows, then ensure exactly one trailing blank ("none") row.
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

  function commit() {
    // Persist only real (non-blank) rows.
    const out = rows.filter((r) => r.type && r.type !== "none");
    passesW.value = JSON.stringify(out);
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

      // type
      const typeSel = makeSelect(TYPE_OPTIONS, row.type, (v) => {
        row.type = v;
        commit();
        render();
      });
      line.appendChild(typeSel);

      // custom name (only when type === custom) else ext/kind shift in
      if (row.type === "custom") {
        line.appendChild(
          makeInput(row.custom, "custom type", (v) => {
            row.custom = v;
            commit();
          }),
        );
      } else {
        const spacer = document.createElement("span");
        line.appendChild(spacer);
      }

      // ext
      line.appendChild(
        makeSelect(EXT_OPTIONS, row.ext, (v) => {
          row.ext = v;
          commit();
        }),
      );

      // kind
      line.appendChild(
        makeSelect(KIND_OPTIONS, row.kind, (v) => {
          row.kind = v;
          commit();
        }),
      );

      // own subfolder toggle
      const chk = document.createElement("input");
      chk.type = "checkbox";
      chk.checked = !!row.own_subfolder;
      chk.title = "own subfolder";
      chk.addEventListener("change", () => {
        row.own_subfolder = chk.checked;
        commit();
      });
      line.appendChild(chk);

      // remove button (not on the trailing blank row)
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

      // optional per-line template override
      if (!isBlank) {
        const tmpl = makeInput(row.template, "template override (optional)", (v) => {
          row.template = v;
          commit();
        });
        tmpl.style.gridColumn = "1 / -1";
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

  const domWidget = node.addDOMWidget("passes_editor", "div", container, {
    serialize: false,
    hideOnZoom: false,
  });

  commit();
  render();
}

// --------------------------------------------------------------------------- //
// Extension registration
// --------------------------------------------------------------------------- //
app.registerExtension({
  name: "projectlogic.ui",

  async nodeCreated(node) {
    if (node.comfyClass !== "ProjectLogic") return;
    buildPassEditor(node);
    hookRefresh(node);
    // Populate dropdowns from any pre-filled project_path.
    setTimeout(() => refreshShots(node).then(() => refreshPlates(node)), 50);
  },
});
