import { app } from "../../../scripts/app.js";
import { getWidget, hideWidget } from "./projectlogic_shared.js";

// --------------------------------------------------------------------------- //
// Pack Noodles / Unpack Noodles
//
// Pack bundles several labelled ANY inputs into one PL_GROUP noodle (so a whole
// group can ride through a single Router Slave wire); Unpack restores them with
// the labels read back from the bundle. Labels are typed in the Pack editor or
// derived from the connected source's type (auto_label).
// --------------------------------------------------------------------------- //

const MAX = 16;
const ADD_SLOT = "__pl_add__";
const LG = () => window.LiteGraph || globalThis.LiteGraph || {};

function parseArr(v) {
  try {
    const a = JSON.parse(v || "[]");
    return Array.isArray(a) ? a : [];
  } catch (e) {
    return [];
  }
}

function uniqueLabel(base, labels) {
  let b = (base || "in").trim() || "in";
  let l = b;
  let i = 2;
  while (labels.includes(l)) l = `${b}_${i++}`;
  return l;
}

function deriveLabel(linkInfo) {
  try {
    const src = app.graph.getNodeById(linkInfo.origin_id);
    const out = src?.outputs?.[linkInfo.origin_slot];
    let t = out?.type;
    if (!t || t === "*") t = out?.name || out?.label || "in";
    return String(t).toLowerCase();
  } catch (e) {
    return "in";
  }
}

// ------------------------------- Pack -------------------------------------- //
function reconcileInputs(node, labels) {
  const named = labels.slice(0, MAX);
  const total = Math.min(named.length + 1, MAX); // +1 trailing "+ input" slot
  while ((node.inputs?.length || 0) > total) {
    node.removeInput(node.inputs.length - 1);
  }
  for (let i = 0; i < total; i++) {
    let slot = node.inputs?.[i];
    if (!slot) {
      node.addInput(ADD_SLOT, "*");
      slot = node.inputs[node.inputs.length - 1];
    }
    slot.type = "*";
    if (i < named.length) {
      slot.name = named[i];
      slot.label = named[i];
      slot.localized_name = named[i];
    } else {
      slot.name = ADD_SLOT;
      slot.label = "+ input";
      slot.localized_name = "+ input";
    }
  }
  node.setSize?.(node.computeSize());
}

function setupPacker(node) {
  const labelsW = getWidget(node, "labels_json");
  const autoW = getWidget(node, "auto_label");
  hideWidget(labelsW);

  let labels = parseArr(labelsW?.value);

  const commit = () => {
    if (labelsW) labelsW.value = JSON.stringify(labels);
  };

  const container = document.createElement("div");
  container.style.cssText = "display:flex;flex-direction:column;gap:2px;padding:3px 2px;";

  let domWidget;
  function renderEditor() {
    container.innerHTML = "";
    labels.forEach((lbl, idx) => {
      const row = document.createElement("div");
      row.style.cssText = "display:grid;grid-template-columns:1fr auto;gap:3px;align-items:center;";
      const inp = document.createElement("input");
      inp.type = "text";
      inp.value = lbl;
      inp.style.cssText =
        "background:#222;color:#ddd;border:1px solid #444;border-radius:4px;font-size:11px;padding:1px 4px;";
      inp.addEventListener("change", () => {
        labels[idx] = uniqueLabel(inp.value, labels.filter((_, j) => j !== idx));
        commit();
        reconcileInputs(node, labels);
        renderEditor();
      });
      const rm = document.createElement("button");
      rm.textContent = "×";
      rm.style.cssText =
        "background:#333;color:#ccc;border:1px solid #555;border-radius:4px;cursor:pointer;width:20px;";
      rm.addEventListener("click", () => {
        labels.splice(idx, 1);
        commit();
        reconcileInputs(node, labels);
        renderEditor();
      });
      row.appendChild(inp);
      row.appendChild(rm);
      container.appendChild(row);
    });
    if (domWidget) domWidget.computeSize = () => [node.size[0], Math.max(24, container.scrollHeight + 6)];
    node.setDirtyCanvas?.(true, true);
  }

  domWidget = node.addDOMWidget("pack_labels", "div", container, { serialize: false });

  const occ = node.onConnectionsChange;
  node.onConnectionsChange = function (type, index, connected, linkInfo) {
    occ?.apply(this, arguments);
    const INPUT = LG().INPUT ?? 1;
    if (type === INPUT && connected && linkInfo) {
      const slot = node.inputs?.[index];
      if (slot && slot.name === ADD_SLOT) {
        const base = autoW?.value ? deriveLabel(linkInfo) : `in_${labels.length + 1}`;
        labels.push(uniqueLabel(base, labels));
        commit();
        reconcileInputs(node, labels);
        renderEditor();
      }
    }
  };

  commit();
  reconcileInputs(node, labels);
  renderEditor();
}

// ------------------------------ Unpack ------------------------------------- //
function readPackLabels(node) {
  return parseArr(getWidget(node, "labels_json")?.value);
}

function sourceOf(node, inputName) {
  const slot = node.inputs?.find((i) => i.name === inputName);
  if (!slot || slot.link == null) return null;
  const link = app.graph.links[slot.link];
  if (!link) return null;
  return app.graph.getNodeById(link.origin_id);
}

// Trace upstream (through reroutes and a router slave) to a Pack node's labels.
function traceLabels(node, inputName, depth = 0) {
  if (depth > 20) return null;
  const src = sourceOf(node, inputName);
  if (!src) return null;
  const c = src.comfyClass;
  if (c === "ProjectLogicPack") return readPackLabels(src);
  if (c === "ProjectLogicRouterSlave") {
    for (const inp of src.inputs || []) {
      if (inp.link != null) {
        const lbls = traceLabels(src, inp.name, depth + 1);
        if (lbls && lbls.length) return lbls;
      }
    }
    return null;
  }
  if ((src.type || c) === "Reroute" && src.inputs?.[0]) {
    return traceLabels(src, src.inputs[0].name, depth + 1);
  }
  return null;
}

function reconcileOutputs(node, labels) {
  const k = Math.min(labels.length, MAX);
  while ((node.outputs?.length || 0) > k) {
    node.removeOutput(node.outputs.length - 1);
  }
  for (let i = 0; i < k; i++) {
    let o = node.outputs?.[i];
    if (!o) {
      node.addOutput(labels[i], "*");
      o = node.outputs[node.outputs.length - 1];
    }
    o.name = labels[i];
    o.label = labels[i];
    o.localized_name = labels[i];
    o.type = "*";
  }
  node.setSize?.(node.computeSize());
}

function setupUnpacker(node) {
  const configure = () => {
    const labels = traceLabels(node, "group") || node._plLastLabels || [];
    if (labels.length) reconcileOutputs(node, labels);
  };

  const occ = node.onConnectionsChange;
  node.onConnectionsChange = function () {
    occ?.apply(this, arguments);
    setTimeout(configure, 20);
  };
  const onCfg = node.onConfigure;
  node.onConfigure = function () {
    onCfg?.apply(this, arguments);
    setTimeout(configure, 60);
  };
  const prevExec = node.onExecuted;
  node.onExecuted = function (message) {
    prevExec?.apply(this, arguments);
    let lbls = message?.labels;
    if (Array.isArray(lbls) && Array.isArray(lbls[0])) lbls = lbls[0];
    if (Array.isArray(lbls) && lbls.length) {
      node._plLastLabels = lbls;
      reconcileOutputs(node, lbls);
    }
  };

  window.addEventListener("projectlogic:changed", () => setTimeout(configure, 15));
  setTimeout(configure, 60);
}

// ----------------------------- registration -------------------------------- //
app.registerExtension({
  name: "projectlogic.pack",

  async nodeCreated(node) {
    try {
      if (node.comfyClass === "ProjectLogicPack") setupPacker(node);
      else if (node.comfyClass === "ProjectLogicUnpack") setupUnpacker(node);
    } catch (e) {
      console.error("[projectlogic] pack/unpack setup failed", node.comfyClass, e);
    }
  },
});
