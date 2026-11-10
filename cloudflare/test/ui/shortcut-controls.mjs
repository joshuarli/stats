import { createComponent, render } from "@solidjs/web";
import { ActionMenu } from "@laputa-systems/ui-dashboard/layout";
import { Select } from "@laputa-systems/ui-dashboard/forms";

const root = document.createElement("div");
root.id = "shortcut-controls";
document.body.append(root);
render(() => [
  createComponent(ActionMenu, { label: "Probe actions", items: [{ id: "logs", label: "Logs" }, { id: "zoom", label: "Zoom details" }], onSelect() {} }),
  createComponent(Select, { id: "probe-scope", label: "Probe scope", value: "logs", options: [{ value: "logs", label: "Logs" }, { value: "zoom", label: "Zoom details" }], onValueChange() {} })
], root);
