import { startContainerSession } from "./container.mts";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OBSERVE_OUTPUT, STATS_OUTPUT } from "../../../cloudflare/local/topology.ts";
import { GATEWAY_IDENTITY_HEADER, GATEWAY_SECRET_HEADER } from "../../../cloudflare/src/cloudflare/gateway.ts";
import { ORANGE_ROOT, generate } from "../generate.mts";
import { freePort, startSession } from "../session.mts";

/** Starts one canary stack. `appRoot` is an app release directory (deploy/orange/app-release.mts); without it the stack serves the working tree's built Workers. */
export async function startStack(stateDir: string, release: string, suppress = false, runtimeRoot = ORANGE_ROOT, container = false, infraVerifier?: string, appRoot?: string) {
  const secret = randomBytes(32).toString("hex");
  const outputs = appRoot === undefined ? { stats: STATS_OUTPUT, observe: OBSERVE_OUTPUT } : { stats: join(appRoot, "stats"), observe: join(appRoot, "observe") };
  const generated = generate(stateDir, { kind: "dev", release, gatewaySecret: secret, nowMs: null }, "in-place", outputs);
  if (suppress || infraVerifier !== undefined) {
    const descriptor = JSON.parse(readFileSync(generated.stats, "utf8"));
    if (suppress) delete descriptor.vars.APPLICATION_EVENTS_RELEASE;
    if (infraVerifier !== undefined) descriptor.vars.INFRA_METRICS_TOKEN_SHA256 = infraVerifier;
    writeFileSync(generated.stats, JSON.stringify(descriptor));
  }
  const port = await freePort();
  const session = container ? await startContainerSession(stateDir, port, runtimeRoot) : await startSession(stateDir, port, { runtimeRoot });
  return { stateDir, release, runtimeRoot, appRoot, historyRuns: [] as unknown[], recovered: false, infraEnabled: infraVerifier !== undefined, origin: session.origin, session, headers: { [GATEWAY_SECRET_HEADER]: secret, [GATEWAY_IDENTITY_HEADER]: "user:canary@example.com" }, stop: session.stop };
}
export type Stack = Awaited<ReturnType<typeof startStack>>;
