import { app } from "../../../scripts/app.js";
import {
  getWidget,
  hideWidget,
  comboFromFn,
} from "./projectlogic_shared.js";

// --------------------------------------------------------------------------- //
// Switch broadcast router (Stamps-style identity).
//
// A Router Master's identity is its **node id** (stable, unique); its `label` is a
// free editable title (duplicates allowed). The master owns an ordered list of
// switch values (`options_json`, edited via the options editor) and picks the
// active one. A Router Slave stores the master's node id in `router_id` (picked
// via a `master` dropdown of labels, disambiguated as "label (id)") and mirrors
// the master's option list to label/order its inputs. Renaming a master never
// breaks the link, and same-named masters stay distinguishable.
// --------------------------------------------------------------------------- //

const MAX_INPUTS = 16;
const NONE = "— none —";

// master id -> active value, shared across the graph.
const ACTIVE = {};

// Parse a master's options_json into a clean, de-duplicated, ordered string list.
function parseOptions(json) {
  let arr;
  try {
    arr = JSON.parse(json || "[]");
  } catch (e) {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const s of arr) {
    if (typeof s !== "string") continue;
    const v = s.trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

// The switch values a master defines (its own list), by node or by id.
function masterOptionsOf(node) {
  return parseOptions(getWidget(node, "options_json")?.value);
}
function masterOptionsById(id) {
  const n = (app.graph?._nodes || []).find(
    (m) => m.comfyClass === "ProjectLogicRouterMaster" && String(m.id) === String(id),
  );
  return n ? masterOptionsOf(n) : [];
}

// ------------------------------- masters ----------------------------------- //
function masterNodes() {
  return (app.graph?._nodes || []).filter(
    (n) => n.comfyClass === "ProjectLogicRouterMaster",
  );
}

// [{id, label, display}], display disambiguated when labels repeat.
function masterList() {
  const ms = masterNodes().map((n) => ({
    id: String(n.id),
    label: (getWidget(n, "label")?.value || "").trim(),
  }));
  const counts = {};
  for (const m of ms) if (m.label) counts[m.label] = (counts[m.label] || 0) + 1;
  for (const m of ms) {
    if (!m.label) m.display = `router ${m.id}`;
    else m.display = counts[m.label] > 1 ? `${m.label} (${m.id})` : m.label;
  }
  return ms;
}
const masterById = (id) => masterList().find((m) => m.id === String(id));
const masterByDisplay = (d) => masterList().find((m) => m.display === d);

function reconfigureAllSlaves() {
  for (const n of app.graph?._nodes || []) {
    if (n.comfyClass === "ProjectLogicRouterSlave") configureSlave(n);
  }
}

// --------------------------- master broadcast ------------------------------ //
function broadcast(id, val) {
  ACTIVE[id] = val;
  for (const n of app.graph?._nodes || []) {
    if (n.comfyClass !== "ProjectLogicRouterSlave") continue;
    if (getWidget(n, "router_id")?.value !== id) continue;
    const w = getWidget(n, "active_type");
    if (w) w.value = val;
    n.setDirtyCanvas?.(true, true);
  }
}

// Editable, ordered list of switch values, backed by the hidden options_json
// widget. Mirrors the hub's pass-line editor: a trailing blank line spawns a new
// one once filled. onChange fires after every committed edit.
function buildOptionsEditor(node, onChange) {
  const optW = getWidget(node, "options_json");
  if (!optW) return;
  hideWidget(optW);

  let rows;
  try {
    rows = JSON.parse(optW.value || "[]");
    if (!Array.isArray(rows)) rows = [];
  } catch (e) {
    rows = [];
  }
  rows = rows.filter((s) => typeof s === "string");

  const container = document.createElement("div");
  container.style.cssText =
    "display:flex;flex-direction:column;gap:3px;padding:4px 2px;font-family:sans-serif;";
  let domWidget;

  // Drop blank lines, then keep exactly one trailing blank to type into.
  function normalize() {
    rows = rows.filter((s) => s.trim() !== "");
    rows.push("");
  }

  // Persist the list to the hidden widget (cheap; safe to call per keystroke).
  function writeOptions() {
    optW.value = JSON.stringify(rows.map((s) => s.trim()).filter((s) => s !== ""));
  }
  // Persist and propagate to active/slaves — only at commit points, not per key.
  function commit() {
    writeOptions();
    onChange?.();
  }

  function render() {
    normalize();
    container.innerHTML = "";

    const header = document.createElement("div");
    header.textContent = "switch options";
    header.style.cssText =
      "color:#888;font-size:10px;text-transform:uppercase;letter-spacing:1px;";
    container.appendChild(header);

    rows.forEach((val, idx) => {
      const isBlank = val.trim() === "";
      const line = document.createElement("div");
      line.style.cssText =
        "display:grid;grid-template-columns:1fr auto;gap:3px;align-items:center;";

      const inp = document.createElement("input");
      inp.type = "text";
      inp.value = val;
      inp.placeholder = isBlank ? "new value… (e.g. ON)" : "";
      inp.style.cssText =
        "background:#222;color:#ddd;border:1px solid #444;border-radius:4px;font-size:11px;padding:1px 4px;min-width:0;";
      // Live-update the value without re-rendering (so typing keeps focus);
      // spawn the next blank line only once the field is committed (blur/enter).
      inp.addEventListener("input", () => {
        rows[idx] = inp.value;
        writeOptions(); // persist only; reconfigure slaves on commit (below)
      });
      inp.addEventListener("change", () => {
        rows[idx] = inp.value;
        commit();
        render();
      });
      line.appendChild(inp);

      const rm = document.createElement("button");
      rm.textContent = isBlank ? "+" : "×";
      rm.title = isBlank ? "add line" : "remove line";
      rm.style.cssText =
        "background:#333;color:#ccc;border:1px solid #555;border-radius:4px;cursor:pointer;width:20px;";
      rm.addEventListener("click", () => {
        if (isBlank) {
          inp.focus();
        } else {
          rows.splice(idx, 1);
          commit();
          render();
        }
      });
      line.appendChild(rm);
      container.appendChild(line);
    });

    const h = Math.max(60, container.scrollHeight + 8);
    if (domWidget) domWidget.computeSize = () => [node.size[0], h];
    node.setSize?.(node.computeSize());
    node.setDirtyCanvas?.(true, true);
  }

  domWidget = node.addDOMWidget("options_editor", "div", container, {
    serialize: false,
    hideOnZoom: false,
  });

  commit();
  render();
}

function setupMaster(node) {
  const labelW = getWidget(node, "label");
  const actW = getWidget(node, "active");
  if (!actW) return;

  comboFromFn(actW, () => masterOptionsOf(node), "");
  const myId = () => String(node.id);

  // Keep `active` valid against the current option list and push the change out.
  function syncActive() {
    const opts = masterOptionsOf(node);
    if (opts.length && !opts.includes(actW.value)) actW.value = opts[0];
    if (!opts.length) actW.value = "";
    broadcast(myId(), actW.value);
    reconfigureAllSlaves(); // relabel/reorder slave inputs to the new options
  }

  buildOptionsEditor(node, syncActive);

  const prevAct = actW.callback;
  actW.callback = function () {
    prevAct?.apply(this, arguments);
    broadcast(myId(), actW.value);
  };
  if (labelW) {
    const prevLabel = labelW.callback;
    labelW.callback = function () {
      prevLabel?.apply(this, arguments);
      reconfigureAllSlaves(); // refresh slave dropdown displays (link is by id)
    };
  }
  const prevRem = node.onRemoved;
  node.onRemoved = function () {
    prevRem?.apply(this, arguments);
    setTimeout(reconfigureAllSlaves, 20);
  };

  // Spawn a new slave already linked to this master (by id).
  node.addWidget("button", "＋ new slave", null, () => {
    const LG = window.LiteGraph || globalThis.LiteGraph;
    if (!LG?.createNode || !app.graph) return;
    const slave = LG.createNode("ProjectLogicRouterSlave");
    if (!slave) return;
    slave.pos = [node.pos[0] + (node.size?.[0] || 220) + 40, node.pos[1]];
    app.graph.add(slave);
    setTimeout(() => {
      const ridW = getWidget(slave, "router_id");
      if (ridW) ridW.value = String(node.id);
      configureSlave(slave); // resolve title, active, slot labels
      app.graph.setDirtyCanvas(true, true);
    }, 60);
  });

  setTimeout(() => {
    if (labelW && !labelW.value) labelW.value = `Router ${node.id}`;
    syncActive(); // seed `active` from the option list and broadcast
  }, 60);
}

// --------------------------- follower routing ------------------------------ //
// Slot NAMES stay input_1..input_N (matching INPUT_TYPES, so links survive
// save/load); the pass type is shown via the slot label, and the slot->type order
// is stored in slot_types for Python routing.
function reconcileInputs(node, types) {
  const k = Math.min(types.length, MAX_INPUTS);
  for (let j = MAX_INPUTS; j > k; j--) {
    const idx = node.inputs?.findIndex((i) => i.name === `input_${j}`);
    if (idx != null && idx >= 0) node.removeInput(idx);
  }
  for (let j = 1; j <= k; j++) {
    let slot = node.inputs?.find((i) => i.name === `input_${j}`);
    if (!slot) {
      node.addInput(`input_${j}`, "*");
      slot = node.inputs[node.inputs.length - 1];
    }
    slot.label = types[j - 1];          // display only — name stays input_j
    slot.localized_name = types[j - 1];
    slot.type = "*";
  }
  const w = getWidget(node, "slot_types");
  if (w) w.value = JSON.stringify(types.slice(0, k));
  node.setSize?.(node.computeSize());
}

function configureSlave(node) {
  const masterW = getWidget(node, "master");
  const ridW = getWidget(node, "router_id");
  const actW = getWidget(node, "active_type");

  const id = ridW?.value || "";
  const m = id ? masterById(id) : null;
  node._plNoMaster = !m; // no resolved master (none selected, or missing)

  // Inputs are labelled/ordered from the linked master's option list. Don't wipe
  // existing slots when the master is momentarily unresolved (e.g. mid-load).
  const types = id ? masterOptionsById(id) : [];
  if (types.length) reconcileInputs(node, types);

  if (masterW) {
    if (m) masterW.value = m.display;        // reflect current (possibly renamed) title
    else if (id) masterW.value = `(missing ${id})`;
    else masterW.value = NONE;
  }
  if (m && actW) {
    const a = ACTIVE[id];
    if (a != null) actW.value = a;
  }
  node.setDirtyCanvas?.(true, true);
}

// Draw a link from the active input to the output (or a red "no master" note).
function installActiveLink(node) {
  const prev = node.onDrawForeground;
  node.onDrawForeground = function (ctx) {
    prev?.apply(this, arguments);
    if (this.flags?.collapsed) return;

    if (this._plNoMaster) {
      ctx.save();
      ctx.fillStyle = "#ff5555";
      ctx.font = "bold 11px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("⚠ no Router Master", this.size[0] / 2, 15);
      ctx.restore();
      return;
    }

    if (!this.outputs?.length) return;
    const active = getWidget(this, "active_type")?.value;
    if (!active) return;
    const id = getWidget(this, "router_id")?.value || "";
    const idx = masterOptionsById(id).indexOf(active);
    if (idx < 0) return;
    const inSlot = this.inputs?.findIndex((i) => i.name === `input_${idx + 1}`);
    if (inSlot == null || inSlot < 0) return;

    const ip = this.getConnectionPos(true, inSlot);
    const op = this.getConnectionPos(false, 0);
    const ax = ip[0] - this.pos[0];
    const ay = ip[1] - this.pos[1];
    const bx = op[0] - this.pos[0];
    const by = op[1] - this.pos[1];
    ctx.save();
    ctx.strokeStyle = "#56ccff";
    ctx.lineWidth = 2.5;
    ctx.globalAlpha = 0.95;
    const dx = Math.max(20, Math.abs(bx - ax) * 0.5);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.bezierCurveTo(ax + dx, ay, bx - dx, by, bx, by);
    ctx.stroke();
    ctx.fillStyle = "#56ccff";
    ctx.beginPath();
    ctx.arc(ax, ay, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };
}

function setupFollower(node) {
  const masterW = getWidget(node, "master");
  const ridW = getWidget(node, "router_id");
  hideWidget(getWidget(node, "active_type"));
  hideWidget(getWidget(node, "slot_types"));
  hideWidget(ridW);

  // master: dropdown of master titles (value resolved to the master's node id).
  comboFromFn(masterW, () => [NONE, ...masterList().map((m) => m.display)], NONE);
  if (masterW) {
    const prev = masterW.callback;
    masterW.callback = function () {
      prev?.apply(this, arguments);
      if (masterW.value === NONE) {
        if (ridW) ridW.value = "";
      } else {
        const m = masterByDisplay(masterW.value);
        if (ridW) ridW.value = m ? m.id : "";
      }
      configureSlave(node);
    };
  }

  const onCfg = node.onConfigure;
  node.onConfigure = function () {
    onCfg?.apply(this, arguments);
    setTimeout(() => configureSlave(node), 50);
  };

  installActiveLink(node);
  setTimeout(() => configureSlave(node), 50);
}

// ----------------------------- registration -------------------------------- //
app.registerExtension({
  name: "projectlogic.router",

  async nodeCreated(node) {
    try {
      if (node.comfyClass === "ProjectLogicRouterMaster") setupMaster(node);
      else if (node.comfyClass === "ProjectLogicRouterSlave") setupFollower(node);
    } catch (e) {
      console.error("[projectlogic] router setup failed", node.comfyClass, e);
    }
  },
});
