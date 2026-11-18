import { createHash } from "node:crypto";
import { main } from "../../../cloudflare/src/cli/run.ts";

type Capability = {
  readonly capability: string;
  readonly status: "healthy" | "degraded" | "unavailable";
  readonly detail: string;
};

const hosts = process.argv[2];
if (process.argv.length !== 3 || hosts === undefined || hosts === "--help") {
  process.stderr.write("usage: node deploy/orange/recovery/check-capabilities.mts EXPECTED_HOSTS\n");
  process.exit(hosts === "--help" ? 0 : 2);
}

async function check(capability: string, probe: () => Promise<Omit<Capability, "capability">>): Promise<Capability> {
  try {
    return { capability, ...await probe() };
  } catch (error) {
    return { capability, status: "unavailable", detail: error instanceof Error ? error.message : "probe failed" };
  }
}

async function get(url: string): Promise<Response> {
  const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
  return response;
}

const results = await Promise.all([
  check("Stats host receipts", async () => {
    let stdout = "";
    let stderr = "";
    const code = await main(["check", "hosts", "--origin", "https://stats.17166969.xyz",
      "--hosts", hosts, "--max-age", "2m"], {
      env: process.env,
      io: { stdout: text => { stdout += text; }, stderr: text => { stderr += text; }, isTty: false }
    });
    if (code !== 0) throw new Error((stderr || stdout).trim());
    return { status: "healthy", detail: "all expected hosts reported within two minutes" };
  }),
  check("Cargo package download", async () => {
    const index = await get("https://crates.17166969.xyz/current/crates-io/se/rd/serde");
    const rows = (await index.text()).trim().split("\n");
    const release = rows.map(row => JSON.parse(row) as { vers: string; cksum: string })
      .find(row => row.vers === "1.0.228");
    if (release === undefined || !/^[a-f0-9]{64}$/u.test(release.cksum)) throw new Error("serde release checksum is missing");
    const archive = await get(`https://crates-blobs.17166969.xyz/blobs/${release.cksum}.crate`);
    const actual = createHash("sha256").update(new Uint8Array(await archive.arrayBuffer())).digest("hex");
    if (actual !== release.cksum) throw new Error("Cargo archive checksum mismatch");
    return { status: "healthy", detail: "serde 1.0.228 checksum verified" };
  }),
  check("Agentctl hosts", async () => {
    const response = await get("https://agentctl.17166969.xyz/api/hosts");
    const data = await response.json() as { hosts?: unknown };
    if (!Array.isArray(data.hosts)) throw new Error("stateful hosts API returned an invalid body");
    return { status: "healthy", detail: `${data.hosts.length} host records read` };
  }),
  check("Discover published search", async () => {
    const origin = "https://hq.17166969.xyz";
    const response = await fetch(`${origin}/search-index.json`, {
      redirect: "manual", signal: AbortSignal.timeout(10_000)
    });
    const snapshot = response.headers.get("X-Discover-Recovery-Snapshot");
    const location = response.headers.get("Location");
    if (!response.ok && (response.status !== 302 || location === null || !/^\/search-index\/[a-f0-9]{64}\.json$/u.test(location))) {
      throw new Error(`search index answered HTTP ${response.status}`);
    }
    const index = response.ok ? response : await get(`${origin}${location}`);
    const data = await index.json() as { documentCount?: unknown };
    if (typeof data.documentCount !== "number" || !Number.isInteger(data.documentCount) || data.documentCount < 1) {
      throw new Error("published index has no documents");
    }
    return snapshot === null
      ? { status: "healthy", detail: `${data.documentCount} indexed documents` }
      : { status: "degraded", detail: `${data.documentCount} indexed documents from snapshot ${snapshot}` };
  })
]);

process.stdout.write(`${JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2)}\n`);
process.exitCode = results.some(result => result.status === "unavailable") ? 4
  : results.some(result => result.status === "degraded") ? 7 : 0;
