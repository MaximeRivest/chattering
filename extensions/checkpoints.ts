import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { checkpointExtension } from "../checkpoint-extension.js";

// Workspace checkpoints for a Pi run outside Chattering's own agent process:
// the same awaited before/after hooks the web sessions get
// (pisdk-runtime.js → checkpoint-extension.js), so a delegated worker's
// edits can be reviewed like the parent's (design/36, design/79).
//
// Load with -e /absolute/path/extensions/checkpoints.ts. Chattering does
// this for delegated workers. Never load it next to the built-in factory in
// a web session: every tool would be captured twice.
export default function (pi: ExtensionAPI) {
  checkpointExtension(pi);
}
