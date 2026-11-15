import { readFileSync } from "node:fs";
import { createProducer } from "../../producer/src/index.ts";
import { PLATFORM_SERVICE } from "./contract.ts";
import { validatePolicy, type BridgePolicy } from "./project.ts";
import { createBridgeServer } from "./server.ts";

const required = (name: string): string => { const value = process.env[name]; if (value === undefined || value === "") throw new TypeError(`missing ${name}`); return value; };
const policy = JSON.parse(readFileSync(required("PLATFORM_POLICY_FILE"), "utf8")) as BridgePolicy;
validatePolicy(policy);
const port = Number(required("PLATFORM_PORT"));
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError("invalid platform port");
const producer = createProducer({ endpoint: required("STATS_ORIGIN"), service: PLATFORM_SERVICE, token: required("STATS_INGEST_TOKEN"), release: required("PLATFORM_BRIDGE_RELEASE"), queueLimit: 128, batchSize: 64, timeoutMs: 1000, maxRetries: 1, maxRetryAfterMs: 1000 });
const bridge = createBridgeServer({ producer, policy, token: required("PLATFORM_OTLP_TOKEN") });
let timer: ReturnType<typeof setInterval> | undefined;
let stopping = false;
async function stop(signal: NodeJS.Signals): Promise<void> {
  if (stopping) return;
  stopping = true;
  if (timer !== undefined) clearInterval(timer);
  const deadline = setTimeout(() => { console.error(JSON.stringify({ event: "platform_shutdown_deadline", queued: producer.stats().queued })); process.exit(1); }, 8000);
  bridge.server.closeIdleConnections();
  const closed = new Promise<void>(done => bridge.server.close(() => done()));
  const force = setTimeout(() => bridge.server.closeAllConnections(), 1000);
  await closed;
  clearTimeout(force);
  bridge.report();
  await producer.shutdown();
  clearTimeout(deadline);
  process.removeAllListeners(signal);
  process.kill(process.pid, signal);
}
for (const signal of ["SIGTERM", "SIGHUP", "SIGINT", "SIGQUIT"] as const) process.on(signal, () => { void stop(signal); });
bridge.server.once("error", async () => { if (timer !== undefined) clearInterval(timer); await producer.shutdown(); console.error(JSON.stringify({ event: "platform_listen_failed" })); process.exitCode = 1; });
bridge.server.listen(port, required("PLATFORM_HOST"), () => { bridge.report(); timer = setInterval(bridge.report, 30_000); timer.unref(); console.log(JSON.stringify({ event: "platform_ready" })); });
