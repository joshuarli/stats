import { startContainerSession } from "./container.mts";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { GATEWAY_IDENTITY_HEADER, GATEWAY_SECRET_HEADER } from "../../../cloudflare/src/cloudflare/gateway.ts";
import { ORANGE_ROOT, generate } from "../generate.mts";
import { freePort, startSession } from "../session.mts";

export async function startStack(stateDir: string, release: string, suppress = false, runtimeRoot = ORANGE_ROOT, container = false, infraVerifier?: string) {
  const secret = randomBytes(32).toString("hex");
  const generated = generate(stateDir, { kind: "dev", release, gatewaySecret: secret, nowMs: null });
  if (suppress || infraVerifier !== undefined) {
    const descriptor = JSON.parse(readFileSync(generated.stats, "utf8"));
    if (suppress) delete descriptor.vars.APPLICATION_EVENTS_RELEASE;
    if (infraVerifier !== undefined) descriptor.vars.INFRA_METRICS_TOKEN_SHA256 = infraVerifier;
    writeFileSync(generated.stats, JSON.stringify(descriptor));
  }
  const port = await freePort();
  const session = container ? await startContainerSession(stateDir, port, runtimeRoot) : await startSession(stateDir, port, { runtimeRoot });
  return { stateDir, release, runtimeRoot, historyRuns: [] as unknown[], recovered: false, infraEnabled: infraVerifier !== undefined, origin: session.origin, session, headers: { [GATEWAY_SECRET_HEADER]: secret, [GATEWAY_IDENTITY_HEADER]: "user:canary@example.com" }, stop: session.stop };
}
export type Stack = Awaited<ReturnType<typeof startStack>>;
