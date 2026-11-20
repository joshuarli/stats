import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { GATEWAY_IDENTITY_HEADER, GATEWAY_SECRET_HEADER } from "../../../cloudflare/src/cloudflare/gateway.ts";
import { generate } from "../generate.mts";
import { freePort, startSession } from "../session.mts";

export async function startStack(stateDir: string, release: string, suppress = false) {
  const secret = randomBytes(32).toString("hex");
  const generated = generate(stateDir, { kind: "dev", release, gatewaySecret: secret, nowMs: null });
  if (suppress) {
    const descriptor = JSON.parse(readFileSync(generated.stats, "utf8"));
    delete descriptor.vars.APPLICATION_EVENTS_RELEASE;
    writeFileSync(generated.stats, JSON.stringify(descriptor));
  }
  const session = await startSession(stateDir, await freePort());
  return { stateDir, release, origin: session.origin, session, headers: { [GATEWAY_SECRET_HEADER]: secret, [GATEWAY_IDENTITY_HEADER]: "user:canary@example.com" }, stop: session.stop };
}
export type Stack = Awaited<ReturnType<typeof startStack>>;
