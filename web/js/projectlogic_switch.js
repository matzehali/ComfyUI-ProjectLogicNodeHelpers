import { app } from "../../../scripts/app.js";
import {
  getWidget,
  hideWidget,
  comboFromFn,
  consumerTypes,
} from "./projectlogic_shared.js";

// --------------------------------------------------------------------------- //
// Active-pass broadcast router.
//
//   ProjectLogicRouterMaster (master)  -- router_id -->  ProjectLogicRouterSlave (N)
//
// The master sets a shared "active type" for a router_id; every slave with that
// router_id routes the matching labelled input to its output. Slot labels and
// ordering come from the project's passes (broadcast or wired bundle).
// --------------------------------------------------------------------------- //

const MAX_INPUTS = 16;

// router_id -> active type, shared across the graph.
const ACTIVE = {};

// router_id of every Router Master in the graph (empty if none exist).
function listMasterIds() {
  const out = [];
  for (const n of app.graph?._nodes || []) {
    if (n.comfyClass !== "ProjectLogicRouterMaster") continue;
    const v = getWidget(n, "router_id")?.value;
    if (v && v !== "NaN" && !out.includes(v)) out.push(v);
  }
  return out;
}

// Ids of all OTHER masters (for uniqueness checks).
function otherMasterIds(exclude) {
  const ids = [];
  for (const n of app.graph?._nodes || []) {
    if (n.comfyClass !== "ProjectLogicRouterMaster" || n === exclude) continue;
    const v = getWidget(n, "router_id")?.value;
    if (v) ids.push(String(v));
  }
  return ids;
}

// Smallest positive integer id not used by another master.
function nextMasterId(exclude) {
  const taken = new Set(otherMasterIds(exclude));
  let i = 1;
  while (taken.has(String(i))) i++;
  return String(i);
}

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
  const idW = getWidget(node, "router_id");
  const actW = getWidget(node, "active");
  if (!idW || !actW) return;

  // Give every master a unique id (never the old "main" default), so masters
  // and slaves never collide on a shared preset.
  if (!idW.value || idW.value === "main" || idW.value === "NaN" ||
      otherMasterIds(node).includes(String(idW.value))) {
    idW.value = nextMasterId(node);
  }
  node._plRouterId = idW.value;
  comboFromFn(actW, () => consumerTypes(node), "base");

  const prevAct = actW.callback;
  actW.callback = function () {
    prevAct?.apply(this, arguments);
    broadcast(idW.value, actW.value);
  };
  const prevId = idW.callback;
  idW.callback = function () {
    prevId?.apply(this, arguments);
    const oldId = node._plRouterId;
    const newId = idW.value;
    // Carry only slaves explicitly tracking the old id; leave others (incl. NaN).
    if (newId && oldId && oldId !== newId) {
      for (const n of app.graph?._nodes || []) {
        if (n.comfyClass !== "ProjectLogicRouterSlave") continue;
        const sidW = getWidget(n, "router_id");
        if (sidW && sidW.value === oldId) sidW.value = newId;
      }
    }
    node._plRouterId = newId;
    reconfigureAllSlaves();
    broadcast(newId, actW.value);
  };

  // Removing the master leaves slaves with no master (NaN/red).
  const prevRem = node.onRemoved;
  node.onRemoved = function () {
    prevRem?.apply(this, arguments);
    setTimeout(reconfigureAllSlaves, 20);
  };

  setTimeout(() => {
    reconfigureAllSlaves(); // NaN slaves adopt this master
    broadcast(idW.value, actW.value);
  }, 60);
}

// --------------------------- follower routing ------------------------------ //
// Slots ARE the pass types: rename each input slot to its type name (Python then
// receives the connected input keyed by that name).
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

// Standalone so the hub-change listener can re-run it for any slave.
// Never mutates router_id — it only flags whether a matching master exists, so a
// slave reconnects on its own if its master reappears and is never silently moved.
function configureSlave(node) {
  const idW = getWidget(node, "router_id");
  const actW = getWidget(node, "active_type");
  reconcileInputs(node, consumerTypes(node));

  node._plNoMaster = !listMasterIds().includes(idW?.value);

  const a = ACTIVE[idW?.value];
  if (a != null && actW) actW.value = a;
  node.setDirtyCanvas?.(true, true);
}

// Draw a link from the active input slot to the output slot.
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
  const idW = getWidget(node, "router_id");
  hideWidget(getWidget(node, "active_type"));

  // router_id: dropdown of all Router Master ids; unconnected default is "NaN".
  comboFromFn(idW, listMasterIds, "NaN");

  if (idW) {
    const prev = idW.callback;
    idW.callback = function () {
      prev?.apply(this, arguments);
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

// When the hub config changes, relabel every slave's inputs.
window.addEventListener("projectlogic:changed", reconfigureAllSlaves);

// ----------------------------- registration -------------------------------- //
app.registerExtension({
  name: "projectlogic.router",

  async nodeCreated(node) {
    try {
      if (node.comfyClass === "ProjectLogicRouterMaster") {
        setupMaster(node);
      } else if (node.comfyClass === "ProjectLogicRouterSlave") {
        setupFollower(node);
      }
    } catch (e) {
      console.error("[projectlogic] router setup failed", node.comfyClass, e);
    }
  },
});
