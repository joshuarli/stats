import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { REGISTRY } from "../../src/cli/commands/index.ts";
import { CLOUDFLARE_DIR, fakeOrigin, runCli } from "./support.ts";

const commandNames = REGISTRY.commands.map(command => command.name);
const helpPaths: string[][] = [
  ["--help"],
  ["-h"],
  ["help"],
  ["help", "workflow"],
  ["observe", "--help"],
  ["help", "observe"],
  ...commandNames.flatMap(name => [[...name.split(" "), "--help"], ["help", ...name.split(" ")]])
];

await test("every help path works offline without a credential command or a socket", async () => {
  const scratchRoot = join(CLOUDFLARE_DIR, "..", ".work", "tmp");
  mkdirSync(scratchRoot, { recursive: true });
  const scratch = mkdtempSync(join(scratchRoot, "help-"));
  const marker = join(scratch, "auth-ran");
  const origin = await fakeOrigin((_, response) => { response.end("{}"); });
  try {
    await Promise.all(helpPaths.map(async path => {
      const run = await runCli(path, { STATSCTL_AUTH_COMMAND: `touch ${marker}`, STATS_URL: origin.origin });
      assert.equal(run.code, 0, `${path.join(" ")}: ${run.stderr}`);
      assert.ok(run.stdout.length > 100, path.join(" "));
      assert.equal(run.stderr, "");
    }));
    assert.equal(existsSync(marker), false, "a credential command ran");
    assert.equal(origin.connections(), 0, "help opened a socket");
    assert.deepEqual(origin.seen, []);
  } finally {
    await origin.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

await test("help states what an agent needs to run each command", async () => {
  const top = (await runCli(["--help"])).stdout;
  for (const name of commandNames) assert.ok(top.includes(name), name);
  for (const needle of ["cf access token", "STATSCTL_AUTH_COMMAND", "half-open", "UTC", "NO_COLOR", "exit codes", "[mutation]"]) assert.ok(top.includes(needle), needle);
  const check = (await runCli(["check", "ingest", "--help"])).stdout;
  assert.match(check, /access: MUTATION/);
  const verify = (await runCli(["verify", "--help"])).stdout;
  assert.match(verify, /--timeout SPAN.*default 30m/);
  assert.match(verify, /access: read-only/);
});

await test("help workflow carries every recipe with the documented spellings", async () => {
  const { stdout } = await runCli(["help", "workflow"]);
  for (const needle of [
    "statsctl projects", "statsctl cost --project stats --window 1h --json", "snapshot --project stats", "--out", "cost --input",
    "deployments --project stats", "compare --project stats --deployment", "verify --project stats --deployment", "--policy", "--wait --timeout",
    "observe routes --project stats --window", "check ingest --credential-file", "insufficient-data", "confounded", "inconclusive",
    "Resume after an interruption", "Why a lower monthly estimate is not necessarily a win"
  ]) assert.ok(stdout.includes(needle), needle);
  assert.doesNotMatch(stdout, /coming soon|not yet|TODO/i);
});

await test("the help path imports no UI module", async () => {
  const script = `
    import { registerHooks } from "node:module";
    const urls = [];
    registerHooks({ resolve(specifier, context, next) { const result = next(specifier, context); urls.push(result.url); return result; } });
    await import("./src/cli/run.ts");
    console.log(JSON.stringify(urls));
  `;
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { cwd: CLOUDFLARE_DIR, stdio: ["ignore", "pipe", "inherit"] });
    let text = "";
    child.stdout.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve(text) : reject(new Error(`exit ${code}`)));
  });
  const urls = JSON.parse(output) as string[];
  assert.ok(urls.some(url => url.endsWith("/src/cli/run.ts")));
  const ui = urls.filter(url => /\.tsx$|solid|uplot|\/src\/client\/(components|pages)\//u.test(url));
  assert.deepEqual(ui, []);
});

await test("statsctl --help starts in at most 300 ms (median of 5)", async t => {
  const walls: number[] = [];
  for (let index = 0; index < 5; index += 1) {
    const started = performance.now();
    const run = await runCli(["--help"]);
    walls.push(performance.now() - started);
    assert.equal(run.code, 0);
  }
  walls.sort((a, b) => a - b);
  const median = walls[2] ?? Infinity;
  t.diagnostic(`median ${median.toFixed(0)} ms of ${walls.map(wall => wall.toFixed(0)).join(", ")}`);
  assert.ok(median <= 300, `median ${median} ms`);
});
