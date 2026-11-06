import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cloudflare = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROJECTS = [
  { id: "alpha", durableObjectNamespaces: ["ns"] },
  { id: "beta", durableObjectNamespaces: [] }
];

async function capture(id: string): Promise<string[]> {
  const scratchRoot = join(cloudflare, "..", ".work", "tmp");
  mkdirSync(scratchRoot, { recursive: true });
  const scratch = mkdtempSync(join(scratchRoot, "capture-"));
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/api/v1/projects") return void response.end(JSON.stringify(PROJECTS));
    const kind = url.searchParams.get("kind");
    if (url.pathname.endsWith("/history") && kind !== null) return void response.end(JSON.stringify({ kind, series: [] }));
    response.statusCode = 404;
    response.end("{}");
  });
  try {
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    const tree = join(scratch, "cloudflare");
    const bin = join(scratch, "bin");
    mkdirSync(join(tree, "scripts"), { recursive: true });
    mkdirSync(join(tree, "test", "ui", "captures"), { recursive: true });
    mkdirSync(bin);
    for (const file of ["capture-project.sh", "api.mjs"]) copyFileSync(join(cloudflare, "scripts", file), join(tree, "scripts", file));
    symlinkSync(join(cloudflare, "src"), join(tree, "src"));
    symlinkSync(join(cloudflare, "test", "support"), join(tree, "test", "support"));
    symlinkSync(process.execPath, join(bin, "node"));
    for (const command of ["jaq"]) {
      const found = (process.env.PATH ?? "").split(":").map(directory => join(directory, command)).find(candidate => existsSync(candidate));
      if (found === undefined) throw new Error(`${command} is not on PATH`);
      symlinkSync(found, join(bin, command));
    }
    writeFileSync(join(bin, "cf"), "#!/bin/sh\necho token\n");
    chmodSync(join(bin, "cf"), 0o755);
    const child = spawn("/bin/sh", [join(tree, "scripts", "capture-project.sh"), id, "1h", "6h"], { env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, STATS_URL: `http://127.0.0.1:${address.port}` }, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    const code = await new Promise<number | null>(done => child.on("close", done));
    assert.equal(code, 0, stderr);
    return readdirSync(join(tree, "test", "ui", "captures", id)).sort();
  } finally {
    await new Promise(done => server.close(done));
    rmSync(scratch, { recursive: true, force: true });
  }
}

await test("a project with Durable Object namespaces is captured with its durable-objects history", async () => {
  const files = await capture("alpha");
  assert.ok(files.includes("durable-objects-1h.json"));
  assert.ok(files.includes("durable-objects-6h.json"));
  assert.ok(files.includes("routes-1h.json"));
});

await test("a project without namespaces gets no durable-objects capture", async () => {
  const files = await capture("beta");
  assert.deepEqual(files.filter(file => file.startsWith("durable-objects")), []);
  assert.ok(files.includes("routes-6h.json"));
});
