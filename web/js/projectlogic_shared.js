import { app } from "../../../scripts/app.js";

// Shared helpers + the project_id broadcast registry, imported by the hub UI
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

// project_id -> config object, rebuilt from the hub nodes on demand.
export const PROJECTS = {};

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
    const w = getWidget(node, f);
    cfg[f] = w ? w.value : undefined;
  }
  if (cfg.global_seed != null) cfg.global_seed = Number(cfg.global_seed) || 0;
  return cfg;
}

export function syncProjects() {
  for (const k in PROJECTS) delete PROJECTS[k];
  for (const n of app.graph?._nodes || []) {
    if (n.comfyClass !== "ProjectLogic") continue;
    const id = getWidget(n, "project_id")?.value || "main";
    PROJECTS[id] = hubConfig(n);
  }
}

export function listProjectIds() {
  syncProjects();
  const ids = Object.keys(PROJECTS);
  return ids.length ? ids : ["main"];
}

export function passesForProject(id) {
  syncProjects();
  const cfg = PROJECTS[id];
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

// Pass types for a consumer: prefer a wired hub, else the project_id broadcast.
export function consumerTypes(node) {
  const up = upstreamNode(node, "project");
  if (up && up.comfyClass === "ProjectLogic") {
    const t = passesFromNode(up);
    if (t.length) return t;
  }
  return passesForProject(getWidget(node, "project_id")?.value || "main");
}

// Mirror the matching project config into every config-consumer's hidden widget.
export function broadcastProjects() {
  syncProjects();
  for (const n of app.graph?._nodes || []) {
    if (!CONFIG_CONSUMERS.includes(n.comfyClass)) continue;
    const w = getWidget(n, "project_config");
    if (!w) continue;
    // A wired PROJECT_LOGIC input takes precedence; clear the mirror then.
    const wired = upstreamNode(n, "project");
    if (wired) {
      w.value = "";
      continue;
    }
    const id = getWidget(n, "project_id")?.value || "main";
    const cfg = PROJECTS[id];
    w.value = cfg ? JSON.stringify(cfg) : "";
  }
}
