import { app } from "../../../scripts/app.js";

// Shared helpers for the hub UI (projectlogic.js) and router UI
// (projectlogic_switch.js). Consumers read the hub's config from the submitted
// PROMPT at run time, so there's nothing to mirror here — the only cross-node
// signal is a "projectlogic:changed" event so edit-time dropdowns/labels refresh.

// Notify edit-time listeners (pass dropdowns, router slot labels) to refresh.
export function notifyChange() {
  try {
    window.dispatchEvent(new CustomEvent("projectlogic:changed"));
  } catch (e) {
    /* no-op */
  }
}

// --------------------------------- widgets --------------------------------- //
export function getWidget(node, name) {
  return node.widgets?.find((w) => w.name === name);
}

export function hideWidget(w) {
  if (!w) return;
  w.hidden = true;
  w.computeSize = () => [0, -4];
  if (w.options) w.options.hidden = true;
  // DOM-backed widgets (multiline etc.) keep an HTML element that ignores the
  // canvas collapse — hide it the way the frontend itself does.
  const el = w.inputEl || w.element;
  if (el) {
    el.hidden = true;
    if (el.style) el.style.display = "none";
  }
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

// The single active (primary) hub node, if any.
export function getPrimaryHub() {
  for (const n of app.graph?._nodes || []) {
    if (n.comfyClass === "ProjectLogic") return n;
  }
  return null;
}

// Pass-type list of the project (configured passes + output + plate).
export function passesForPrimary() {
  const hub = getPrimaryHub();
  return hub ? passesFromNode(hub) : [];
}

// Pass types for a consumer come from the single project.
export function consumerTypes(node) {
  return passesForPrimary();
}
