import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { startGateway, gatewaySecret } from "../../cloudflare/local/gateway.ts";
import { generate } from "./generate.mts";
import { freePort, startSession, type Session } from "./session.mts";

const scratch = resolve(import.meta.dirname, "../../.work/tmp");
const state = mkdtempSync(join(scratch, "orange-dev-"));
const secret = gatewaySecret();
let session: Session | undefined;
let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
let signal: NodeJS.Signals | undefined;
let wake: (() => void) | undefined;
for (const name of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const) {
  process.on(name, () => { signal ??= name; wake?.(); });
}
try {
  generate(state, { kind: "dev", release: "local", gatewaySecret: secret, nowMs: null });
  session = await startSession(state, await freePort());
  if (signal === undefined) gateway = await startGateway(session.origin, secret);
  if (signal === undefined) {
    console.log(`OpenOrange: ${gateway!.origin}`);
    await Promise.race([
      new Promise<void>(done => { wake = done; if (signal !== undefined) done(); }),
      new Promise<never>((_, reject) => session!.child.once("exit", (code, name) => reject(new Error(`OpenOrange exited: ${code ?? name}`))))
    ]);
  }
} finally {
  await gateway?.close();
  await session?.stop();
  rmSync(state, { recursive: true, force: true });
}

if (signal !== undefined) {
  process.removeAllListeners(signal);
  process.kill(process.pid, signal);
}
