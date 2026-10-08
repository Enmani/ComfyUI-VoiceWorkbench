import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { configureHost } from "./host.js";
import { ProsodyEditor } from "./editor.js";
import { TAB_ID, NODE_TYPE, nodeWidget } from "./common.js";
configureHost(app, api);


const editor = new ProsodyEditor();
async function openProsody(path, lineId, boundNode = null) {
  if (editor.busy || editor.drag) { editor.setStatus("Finish the current operation before opening another line.", "error"); return; }
  const panel = app.extensionManager?.bottomPanel;
  if (panel?.toggleBottomPanelTab) {
    if (!panel.bottomPanelVisible || panel.activeBottomPanelTabId !== TAB_ID) panel.toggleBottomPanelTab(TAB_ID);
  } else {
    // The registered command is also provided by the installed frontend tab API.
    app.extensionManager?.command?.execute?.(`Workspace.ToggleBottomPanelTab.${TAB_ID}`);
  }
  const loaded = await editor.open(path, lineId);
  if (loaded) { editor.boundNode = boundNode; editor.syncBoundNode(); }
}

app.registerExtension({
  name: "VoiceWorkbench",
  bottomPanelTabs: [{ id: TAB_ID, title: "Voice Workbench", type: "custom", render: host => editor.mount(host) }],
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_TYPE) return;
    const original = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = original?.apply(this, arguments);
      const open = this.addWidget("button", "Open editor", null, () => openProsody(nodeWidget(this, "document_path"), nodeWidget(this, "line_id"), this));
      open.serialize = false;
      this.size[0] = Math.max(this.size[0], 430);
      return result;
    };
  },
});

// Explicitly triggered opening is useful to local integration tools; startup never changes the graph.
window.addEventListener("voice-workbench:open", event => {
  if (event.detail?.path) void openProsody(event.detail.path, event.detail.line_id);
});
