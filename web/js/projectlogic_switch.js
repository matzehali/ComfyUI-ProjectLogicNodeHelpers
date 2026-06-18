import { app } from "../../../scripts/app.js";
import {
  getWidget,
  hideWidget,
  comboFromFn,
  consumerTypes,
  listProjectIds,
  broadcastProjects,
} from "./projectlogic_shared.js";

// --------------------------------------------------------------------------- //
// Active-pass broadcast router.
//
//   ProjectLogicRouterMaster (master)  -- router_id -->  ProjectLogicRouterSlave (N)
//
// The master sets a shared "active type" for a router_id; every slave with that
// router_id routes the matching labelled input to its output. Slot labels and
// ordering come from the project's passes (via project_id / wired bundle).
// --------------------------------------------------------------------------- //

const MAX_INPUTS = 16;

// router_id -> active type, shared across the graph.
const ACTIVE = {};

// Collect the router_id of every Router Master in the graph.
function listMasterIds() {
  const out = [];
  for (const n of app.graph?._nodes || []) {
    if (n.comfyClass !== "ProjectLogicRouterMaster") continue;
    const v = getWidget(n, "router_id")?.value;
    if (v && !out.includes(v)) out.push(v);
  }
  return out.length ? out : ["main"];
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
  const idW = getWidget(node, "router_id");
  const projW = getWidget(node, "project_id");
  const actW = getWidget(node, "active");
  if (!idW || !actW) return;

  comboFromFn(projW, listProjectIds, "main");
  comboFromFn(actW, () => consumerTypes(node), "base");

  const prevAct = actW.callback;
  actW.callback = function () {
    prevAct?.apply(this, arguments);
    broadcast(idW.value, actW.value);
  };
  const prevId = idW.callback;
  idW.callback = function () {
    prevId?.apply(this, arguments);
    broadcast(idW.value, actW.value);
  };
  const occ = node.onConnectionsChange;
  node.onConnectionsChange = function () {
    occ?.apply(this, arguments);
    setTimeout(() => broadcast(idW.value, actW.value), 10);
  };
  setTimeout(() => broadcast(idW.value, actW.value), 60);
}

// --------------------------- follower routing ------------------------------ //
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
    slot.label = types[j - 1];
  }
  node.setSize?.(node.computeSize());
}

// Draw a link from the active input slot to the output slot.
function installActiveLink(node) {
  const prev = node.onDrawForeground;
  node.onDrawForeground = function (ctx) {
    prev?.apply(this, arguments);
    if (this.flags?.collapsed) return;
    if (!this.outputs?.length) return;

    const active = getWidget(this, "active_type")?.value;
    if (!active) return;
    const types = consumerTypes(this);
    const idx = types.indexOf(active);
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
  const idW = getWidget(node, "router_id");
  const projW = getWidget(node, "project_id");
  const actW = getWidget(node, "active_type");
  hideWidget(actW);

  // router_id: dropdown of all Router Master ids.
  comboFromFn(idW, listMasterIds, "main");
  // project_id: dropdown of all projects (drives slot labels).
  comboFromFn(projW, listProjectIds, "main");

  function configure() {
    const types = consumerTypes(node);
    reconcileInputs(node, types);
    const a = ACTIVE[idW?.value];
    if (a != null && actW) actW.value = a;
    broadcastProjects(); // refresh this slave's mirrored project_config
    node.setDirtyCanvas?.(true, true);
  }

  for (const w of [idW, projW]) {
    if (!w) continue;
    const prev = w.callback;
    w.callback = function () {
      prev?.apply(this, arguments);
      configure();
    };
  }
  const occ = node.onConnectionsChange;
  node.onConnectionsChange = function () {
    occ?.apply(this, arguments);
    setTimeout(configure, 10);
  };
  const onCfg = node.onConfigure;
  node.onConfigure = function () {
    onCfg?.apply(this, arguments);
    setTimeout(configure, 50);
  };

  installActiveLink(node);
  setTimeout(configure, 50);
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
