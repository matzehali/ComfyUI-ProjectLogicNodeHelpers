import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { getWidget } from "./projectlogic_shared.js";

// SelectPath: a Browse button that opens the native OS file/folder dialog on the
// server host and drops the chosen absolute path into the `path` widget.
app.registerExtension({
  name: "projectlogic.selectpath",

  async nodeCreated(node) {
    if (node.comfyClass !== "ProjectLogicSelectPath") return;

    const pathW = getWidget(node, "path");
    const modeW = getWidget(node, "mode");

    node.addWidget("button", "📁 Browse…", null, async () => {
      const mode = modeW?.value || "folder";
      node._plBrowsing = true;
      node.setDirtyCanvas?.(true, true);
      try {
        const res = await api.fetchApi(`/projectlogic/browse?mode=${encodeURIComponent(mode)}`);
        if (!res.ok) return;
        const data = await res.json();
        if (data?.path && pathW) {
          pathW.value = data.path;
          pathW.callback?.(pathW.value);
        }
      } catch (e) {
        console.warn("[projectlogic] browse failed", e);
      } finally {
        node._plBrowsing = false;
        node.setDirtyCanvas?.(true, true);
      }
    });
  },
});
