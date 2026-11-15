import type { BridgePolicy } from "../../../packages/platform-bridge/src/project.ts";
const key = "1".repeat(64), other = "2".repeat(64);
const policy: BridgePolicy = { resourceService: "stats-runtime", openorangeVersion: "1.0.2", rivetkitVersion: "3.1.2-rc.1", nativeVersion: "3.1.1", samplePpm: 100000, actors: [{ role: "installation", name: "installation-1234abcd", key }, { role: "observation", name: "observation-store-1234abcd", key: other }] };
const attribute = (key: string, stringValue: string) => ({ key, value: { stringValue } });
function batch() {
  return { resourceSpans: [{ resource: { attributes: [attribute("service.name", "stats-runtime"), attribute("service.version", "stats-123456789abc"), attribute("openorange.version", "1.0.2"), attribute("rivetkit.version", "3.1.1")] }, scopeSpans: [{ scope: { name: "rivetkit" }, spans: [{ name: "installation-1234abcd/onRequest", traceId: "a".repeat(32), spanId: "b".repeat(16), startTimeUnixNano: "1794700000000000000", endTimeUnixNano: "1794700000001234500", status: { code: 0 }, attributes: [attribute("rivet.actor.name", "installation-1234abcd"), attribute("rivet.actor.key", key), attribute("rivet.actor.id", "secret-actor-id"), attribute("db.statement", "SELECT SECRET"), attribute("http.request.body", "secret-body")] }] }] }] };
}

export { attribute, batch, policy };
