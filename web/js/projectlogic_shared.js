import { app } from "../../../scripts/app.js";

// Shared helpers + the single-project broadcast, imported by the hub UI
// (projectlogic.js) and the router UI (projectlogic_switch.js).

// Config keys mirrored hub -> consumer (must match CONFIG_FIELDS in nodes.py).
export const CONFIG_FIELDS = [
  "project_path", "shot", "global_seed",
  "default_template", "output_template", "plate_clip", "passes_json",
];

// Node classes that carry a hidden project_config (rebuild bundle in Python).
const CONFIG_CONSUMERS = [
  "ProjectLogicExtract", "ProjectLogicPreview", "ProjectLogicRouterSlave",
];

// --------------------------------- widgets --------------------------------- //
export function getWidget(node, name) {
  return node.widgets?.find((w) => w.name === name);
}

export function hideWidget(w) {
  if (!w) return;
  w.hidden = true;
  w.computeSize = () => [0, -4];
}

// Static-list combo (values supplied as an array).
export function asCombo(w, values, keepCurrent = true) {
  if (!w) return;
  w.type = "combo";
  w.options = w.options || {};
  let list = Array.isArray(values) ? values.slice() : [];
  if (keepCurrent && w.value && !list.includes(w.value)) list.unshift(w.value);
  if (!list.length) list = [w.value || ""];
  w.options.values = list;
  if (!list.includes(w.value)) w.value = list[0];
}

// Live combo whose options are recomputed each time the menu opens.
export function comboFromFn(w, fn, fallback = "main") {
  if (!w) return;
  w.type = "combo";
  w.options = w.options || {};
  w.options.values = () => {
    let list = fn() || [];
    if (w.value && !list.includes(w.value)) list = [w.value, ...list];
    if (!list.length) list = [w.value || fallback];
    return list;
  };
  if (!w.value) w.value = fallback;
}

// ------------------------------- graph walk -------------------------------- //
export function upstreamNode(node, inputName) {
  const slot = node.inputs?.find((i) => i.name === inputName);
  if (!slot || slot.link == null) return null;
  const link = app.graph.links[slot.link];
  if (!link) return null;
  return app.graph.getNodeById(link.origin_id);
}

// Trace a wired input through reroutes to the real source node.
export function upstreamSourceNode(node, inputName) {
  const slot = node.inputs?.find((i) => i.name === inputName);
  if (!slot || slot.link == null) return null;
  let link = app.graph.links[slot.link];
  let guard = 0;
  while (link && guard++ < 32) {
    const src = app.graph.getNodeById(link.origin_id);
    if (!src) return null;
    if ((src.type || src.comfyClass) === "Reroute") {
      const rin = src.inputs?.[0];
      if (rin && rin.link != null) {
        link = app.graph.links[rin.link];
        continue;
      }
      return null;
    }
    return src;
  }
  return null;
}

// Best-effort string value produced by a (string/primitive) source node.
function readStringOutput(node) {
  if (!node?.widgets) return "";
  const named = node.widgets.find(
    (w) =>
      typeof w.value === "string" &&
      ["value", "text", "string", "path"].includes(String(w.name || "").toLowerCase()),
  );
  if (named) return named.value;
  const anyStr = node.widgets.find((w) => typeof w.value === "string");
  return anyStr ? anyStr.value : "";
}

// Resolve a field by name: a wired input is traced upstream to its string
// value; otherwise the node's own widget value is used.
export function fieldValue(node, name) {
  const inSlot = node.inputs?.find((i) => i.name === name);
  if (inSlot && inSlot.link != null) {
    const src = upstreamSourceNode(node, name);
    if (src) return readStringOutput(src);
  }
  const w = getWidget(node, name);
  return w ? w.value : undefined;
}

function passesFromArr(arr) {
  const out = [];
  for (const r of Array.isArray(arr) ? arr : []) {
    let t = r?.type;
    if (t === "custom") t = (r.custom || "").trim();
    if (t && t !== "none") out.push(t);
  }
  out.push("output", "plate");
  return out;
}

// Pass-type list directly from a ProjectLogic node's passes_json widget.
export function passesFromNode(hubNode) {
  const w = getWidget(hubNode, "passes_json");
  if (!w) return [];
  let arr = [];
  try {
    arr = JSON.parse(w.value || "[]");
  } catch (e) {
    arr = [];
  }
  return passesFromArr(arr);
}

// ----------------------------- project registry ---------------------------- //
function hubConfig(node) {
  const cfg = {};
  for (const f of CONFIG_FIELDS) {
    cfg[f] = fieldValue(node, f);  // resolves wired inputs upstream
  }
  if (cfg.global_seed != null) cfg.global_seed = Number(cfg.global_seed) || 0;
  return cfg;
}

// The single active (primary) hub node, if any.
export function getPrimaryHub() {
  for (const n of app.graph?._nodes || []) {
    if (n.comfyClass === "ProjectLogic" && !n._plDuplicate) return n;
  }
  return null;
}

export function primaryConfig() {
  const n = getPrimaryHub();
  return n ? hubConfig(n) : null;
}

export function passesForPrimary() {
  const cfg = primaryConfig();
  let arr = [];
  if (cfg && cfg.passes_json) {
    try {
      arr = JSON.parse(cfg.passes_json);
    } catch (e) {
      arr = [];
    }
  }
  return passesFromArr(arr);
}

// Pass types for a consumer come from the single project.
export function consumerTypes(node) {
  return passesForPrimary();
}

// Mirror the project config into every config-consumer's hidden widget, then
// let interested nodes (e.g. router slaves) refresh.
export function broadcastProjects() {
  const cfg = primaryConfig();
  const json = cfg ? JSON.stringify(cfg) : "";
  for (const n of app.graph?._nodes || []) {
    if (!CONFIG_CONSUMERS.includes(n.comfyClass)) continue;
    const w = getWidget(n, "project_config");
    if (w) w.value = json;
  }
  try {
    window.dispatchEvent(new CustomEvent("projectlogic:changed"));
  } catch (e) {
    /* no-op */
  }
}
