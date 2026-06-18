import { app } from "../../../scripts/app.js";
import {
  getWidget,
  hideWidget,
  comboFromFn,
  consumerTypes,
} from "./projectlogic_shared.js";

// --------------------------------------------------------------------------- //
// Active-pass broadcast router (Stamps-style identity).
//
// A Router Master's identity is its **node id** (stable, unique); its `label` is a
// free editable title (duplicates allowed). A Router Slave stores that node id in
// `router_id` and picks it via a `master` dropdown that shows labels (duplicate
// labels are disambiguated as "label (id)"). Renaming a master never breaks the
// link, and same-named masters stay distinguishable.
// --------------------------------------------------------------------------- //

const MAX_INPUTS = 16;
const NONE = "— none —";

// master id -> active type, shared across the graph.
const ACTIVE = {};

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

function setupMaster(node) {
  const labelW = getWidget(node, "label");
  const actW = getWidget(node, "active");
  if (!actW) return;

  comboFromFn(actW, () => consumerTypes(node), "base");
  const myId = () => String(node.id);

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
    reconfigureAllSlaves();
    broadcast(myId(), actW.value);
  }, 60);
}

// --------------------------- follower routing ------------------------------ //
// Slots ARE the pass types: rename each input slot to its type name.
function reconcileInputs(node, types) {
  const k = Math.min(types.length, MAX_INPUTS);
  while ((node.inputs?.length || 0) > k) {
    node.removeInput(node.inputs.length - 1);
  }
  for (let i = 0; i < k; i++) {
    let slot = node.inputs?.[i];
    if (!slot) {
      node.addInput(types[i], "*");
      slot = node.inputs[node.inputs.length - 1];
    }
    slot.name = types[i];
    slot.label = types[i];
    slot.localized_name = types[i];
    slot.type = "*";
  }
  node.setSize?.(node.computeSize());
}

function configureSlave(node) {
  const masterW = getWidget(node, "master");
  const ridW = getWidget(node, "router_id");
  const actW = getWidget(node, "active_type");
  reconcileInputs(node, consumerTypes(node));

  const id = ridW?.value || "";
  const m = id ? masterById(id) : null;
  node._plNoMaster = !m; // no resolved master (none selected, or missing)

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
    const inSlot = this.inputs?.findIndex((i) => i.name === active);
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

// When the hub config changes, relabel every slave's input slots.
window.addEventListener("projectlogic:changed", reconfigureAllSlaves);

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
