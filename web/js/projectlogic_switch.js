import { app } from "../../../scripts/app.js";

// --------------------------------------------------------------------------- //
// Active-pass broadcast switch system.
//
//   ProjectLogicRouterMaster (master)  -- router_id -->  ProjectLogicRouterSlave (N)
//
// The master has no output noodles; it sets a shared "active type" for a given
// router_id, and every follower with the same router_id routes the matching
// labelled input to its output. Slot labels come from the connected
// Project Logic node's configured passes.
// --------------------------------------------------------------------------- //

const MAX_INPUTS = 16;
const FALLBACK_TYPES = ["base", "mask", "depthmap", "output"];

// router_id -> active type / type list, shared across all nodes in the graph.
const ACTIVE = {};
const TYPES = {};

// ----------------------------- small helpers ------------------------------- //
function getWidget(node, name) {
  return node.widgets?.find((w) => w.name === name);
}

function hideWidget(w) {
  if (!w) return;
  w.hidden = true;
  w.computeSize = () => [0, -4];
}

function asCombo(w, values) {
  if (!w) return;
  w.type = "combo";
  w.options = w.options || {};
  let list = Array.isArray(values) && values.length ? values.slice() : [w.value || ""];
  if (w.value && !list.includes(w.value)) list.unshift(w.value);
  w.options.values = list;
  if (!list.includes(w.value)) w.value = list[0];
}

function upstreamNode(node, inputName) {
  const slot = node.inputs?.find((i) => i.name === inputName);
  if (!slot || slot.link == null) return null;
  const link = app.graph.links[slot.link];
  if (!link) return null;
  return app.graph.getNodeById(link.origin_id);
}

function passesFromProjectNode(pn) {
  const w = getWidget(pn, "passes_json");
  if (!w) return [];
  let arr = [];
  try {
    arr = JSON.parse(w.value || "[]");
  } catch (e) {
    arr = [];
  }
  const out = [];
  for (const r of arr) {
    let t = r?.type;
    if (t === "custom") t = (r.custom || "").trim();
    if (t && t !== "none") out.push(t);
  }
  out.push("output", "plate");
  return out;
}

function typesForNode(node) {
  const up = upstreamNode(node, "project");
  if (up && up.comfyClass === "ProjectLogic") {
    const t = passesFromProjectNode(up);
    if (t.length) return t;
  }
  const id = getWidget(node, "router_id")?.value;
  if (id && TYPES[id]?.length) return TYPES[id];
  return FALLBACK_TYPES.slice();
}

// Collect the router_id of every Router Master currently in the graph.
function listMasterIds() {
  const out = [];
  for (const n of app.graph?._nodes || []) {
    if (n.comfyClass !== "ProjectLogicRouterMaster") continue;
    const v = getWidget(n, "router_id")?.value;
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
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

  function refresh() {
    const types = typesForNode(node);
    TYPES[idW.value] = types;
    asCombo(actW, types);
    broadcast(idW.value, actW.value);
  }

  const prevAct = actW.callback;
  actW.callback = function () {
    prevAct?.apply(this, arguments);
    broadcast(idW.value, actW.value);
  };
  const prevId = idW.callback;
  idW.callback = function () {
    prevId?.apply(this, arguments);
    refresh();
  };
  const occ = node.onConnectionsChange;
  node.onConnectionsChange = function () {
    occ?.apply(this, arguments);
    setTimeout(refresh, 10);
  };
  setTimeout(refresh, 50);
}

// --------------------------- follower routing ------------------------------ //
function reconcileInputs(node, types) {
  const k = Math.min(types.length, MAX_INPUTS);

  // Trim trailing input_ slots beyond k (keeps low-index name mapping intact).
  for (let j = MAX_INPUTS; j > k; j--) {
    const idx = node.inputs?.findIndex((i) => i.name === `input_${j}`);
    if (idx != null && idx >= 0) node.removeInput(idx);
  }
  // Ensure input_1..input_k exist and carry the pass label.
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

function setupFollower(node) {
  const idW = getWidget(node, "router_id");
  const slotW = getWidget(node, "slot_types");
  const actW = getWidget(node, "active_type");
  hideWidget(slotW);
  hideWidget(actW);

  // router_id is a live dropdown of every Router Master id in the graph.
  if (idW) {
    idW.type = "combo";
    idW.options = idW.options || {};
    idW.options.values = () => {
      const ids = listMasterIds();
      if (idW.value && !ids.includes(idW.value)) ids.unshift(idW.value);
      if (!ids.length) ids.push(idW.value || "main");
      return ids;
    };
    if (!idW.value) idW.value = "main";
  }

  function configure() {
    const types = typesForNode(node);
    if (slotW) slotW.value = JSON.stringify(types);
    reconcileInputs(node, types);
    const a = ACTIVE[idW?.value];
    if (a != null && actW) actW.value = a;
    node.setDirtyCanvas?.(true, true);
  }

  if (idW) {
    const prevId = idW.callback;
    idW.callback = function () {
      prevId?.apply(this, arguments);
      configure();
    };
  }
  const occ = node.onConnectionsChange;
  node.onConnectionsChange = function () {
    occ?.apply(this, arguments);
    setTimeout(configure, 10);
  };
  setTimeout(configure, 50);
}

// ----------------------------- registration -------------------------------- //
app.registerExtension({
  name: "projectlogic.switch",

  async nodeCreated(node) {
    if (node.comfyClass === "ProjectLogicRouterMaster") setupMaster(node);
    else if (node.comfyClass === "ProjectLogicRouterSlave") setupFollower(node);
  },
});
