import type { CostInputs } from "../snapshot-format.ts";
import { encodeSnapshot, inputDigests, serializeSnapshot } from "../snapshot-format.ts";
import { loadCostInputs, resolveLive } from "../cost-load.ts";
import { defineCommand } from "../registry.ts";
import { cliRevision, writeSnapshotFile } from "../snapshot-store.ts";
import { table } from "../text.ts";
import { parseWindowRequest } from "../windows.ts";
import { PRICING_REVISION } from "../../cost/pricing.ts";
import { MEASUREMENT_REVISION } from "../revisions.ts";
import { listProjects, reportOf, selectProject, windowOption } from "./cost.ts";

export interface SnapshotPayload {
  readonly file: string;
  readonly bytes: number;
  readonly pruned: number;
  readonly requests: { readonly shared: number; readonly project: number };
  readonly inputs: readonly { readonly name: string; readonly sha256: string }[];
}

export const snapshotCommand = defineCommand<SnapshotPayload>({
  name: "snapshot",
  summary: "save the exact inputs of a cost report so it can be replayed offline",
  description: [
    "Reads the history frames and, for an observed project with Durable Objects, the method statistics for one window, and writes them with the resolved windows, project configuration, revisions, the git SHA of this checkout, and a SHA-256 of each input. Credentials are never stored, and observe stack frames are never read.",
    "Replay with `statsctl cost --input FILE`: it makes no request and runs no credential command.",
    "A bare file name goes to .work/statsctl/snapshots/ at the repository root; a path is used as given. Only that default directory is pruned, oldest first, to 200 MiB."
  ],
  access: "read",
  options: {
    project: { type: "string", placeholder: "ID", required: true, description: "project id from `statsctl projects`" },
    ...windowOption,
    out: { type: "string", placeholder: "FILE", required: true, description: "snapshot path; a bare file name is written to .work/statsctl/snapshots/" }
  },
  examples: ["statsctl snapshot --project stats --window 24h --out stats-24h.json"],
  limitations: ["Each snapshot is capped at 4 MiB and is refused with exit 4 above it; the directory is capped at 200 MiB.", "The window is a settled trailing window; use `cost --from --to` for an exact window."],
  async run(context) {
    const out = context.option("out") ?? "";
    const request = parseWindowRequest({ window: context.option("window"), from: undefined, to: undefined, monthToDate: false });
    const capturedAtMs = context.now();
    const project = selectProject(await listProjects(context), context.option("project") ?? "");
    const windows = await resolveLive(context, project.id, request);
    const shared = context.http.requests();
    const inputs: CostInputs = await loadCostInputs(context, project, windows, capturedAtMs, shared);
    reportOf(inputs);
    const snapshot = encodeSnapshot(inputs, cliRevision());
    const written = writeSnapshotFile(out, serializeSnapshot(snapshot));
    return {
      project: project.id,
      windows: [windows.current, windows.previous],
      pricingRevision: PRICING_REVISION,
      measurementRevision: MEASUREMENT_REVISION,
      warnings: inputs.notes,
      payload: { file: written.path, bytes: written.bytes, pruned: written.pruned, requests: inputs.requests, inputs: inputDigests(snapshot) }
    };
  },
  render(payload) {
    return [`snapshot written to ${payload.file} (${payload.bytes} bytes, ${payload.requests.shared + payload.requests.project} requests)`, ...table(payload.inputs.map(input => [input.name, input.sha256]))];
  }
});
