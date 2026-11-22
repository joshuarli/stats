// Reads back every acknowledged synthetic write of a soak from the host's raw history.
//   node --experimental-strip-types bench/standby-soak-ledger.mts --origin URL --host-id ID --from MS --to MS
// Prints one JSON line {"kind":"ledger","found":[atMs...],"windows":N} for bench/analyze-standby-soak.py.
// The check's sequence equals its sample time, so a write is present when its time appears in the
// summary table. Raw history spans at most 12 hours per read; this reads hour by hour. Reads carry
// no credential: on the tailnet origin, tailscale serve supplies the identity.
import { parseArgs } from "node:util";
import { openHistory } from "../cloudflare/src/binary/history.ts";
import { decodeSummary } from "../cloudflare/src/client/history.ts";
import { HOUR_MS } from "../cloudflare/src/limits.ts";

const { values } = parseArgs({ options: { origin: { type: "string" }, "host-id": { type: "string" }, from: { type: "string" }, to: { type: "string" } } });
const from = Number(values.from), to = Number(values.to);
if (!values.origin || !values["host-id"] || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from >= to) {
  process.stderr.write("usage: standby-soak-ledger.mts --origin URL --host-id ID --from MS --to MS\n");
  process.exit(2);
}
const found = new Set<number>();
let windows = 0;
for (let start = from; start < to; start += HOUR_MS) {
  const end = Math.min(to, start + HOUR_MS);
  const response = await fetch(`${values.origin}/api/v1/hosts/${values["host-id"]}/history?from=${start}&to=${end}&kind=summary`, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`history ${start}-${end} answered ${response.status}`);
  for (const time of decodeSummary(openHistory(new Uint8Array(await response.arrayBuffer())).root).table.times) if (time >= start && time < end) found.add(time);
  windows++;
}
process.stdout.write(JSON.stringify({ kind: "ledger", found: [...found].sort((a, b) => a - b), windows, fromMs: from, toMs: to }) + "\n");
