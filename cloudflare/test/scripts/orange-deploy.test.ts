import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { test } from "node:test";
import { deployStats } from "../../../deploy/orange/deploy.mts";
import { runCommand } from "../../../deploy/orange/command.mts";

const root = resolve(import.meta.dirname, "../../..");
const oldImage = "stats:aaaaaaaaaaaa", newImage = "stats:bbbbbbbbbbbb";

function deploymentFailureMessages(error: unknown): [string, string] {
  assert.ok(error instanceof AggregateError);
  const errors: readonly unknown[] = error.errors;
  assert.equal(errors.length, 2);
  const [primary, rollback] = errors;
  assert.ok(primary instanceof Error); assert.ok(rollback instanceof Error);
  return [primary.message, rollback.message];
}

function fixture(failure = "none", mode: "check" | "deploy" = "deploy") {
  const controller = new AbortController(), calls: { file: string; words: string[] }[] = [], progress: string[] = [];
  let selected = { image: oldImage, version: 1 }, running = { ...selected }, clock = 0, firstRestartCompleted = false;
  if (failure === "current") { selected = { image: newImage, version: 2 }; running = { ...selected }; }
  if (failure === "drift") running.version = 9;
  const run = async (file: string, args: readonly string[], options: { signal?: AbortSignal | undefined }) => {
    options.signal?.throwIfAborted();
    const words = file === "ssh" ? [...args.at(-1)!.matchAll(/'([^']*)'/gu)].map(match => match[1]!) : args;
    calls.push({ file, words: [...words] });
    if (file.endsWith("build-image.sh")) return newImage;
    if (file === "curl") { if (failure === "health") { clock += 10000; throw new Error("unhealthy"); } return "{}"; }
    if (file.endsWith("deployed-smoke.sh")) {
      if (failure === "concurrent") selected = { image: "stats:cccccccccccc", version: 3 };
      if (failure === "concurrent-same") selected = { image: newImage, version: 4 };
      if (["smoke", "concurrent", "concurrent-same", "rollback", "rollback-deadline"].includes(failure)) throw new Error("smoke failed");
      return "OK";
    }
    if (words.includes("record-deployment")) { if (failure === "marker") throw new Error("marker failed"); return ""; }
    if (words.includes("deployment")) return JSON.stringify(failure === "fenced" ? { ...selected, recoveryWriter: "127.0.0.1:18489" } : selected);
    if (words.includes("set-image")) {
      const index = words.indexOf("set-image"), image = words[index + 2]!;
      assert.equal(words.at(-1), selected.image);
      if (image !== selected.image) selected = { image, version: selected.version + 1 };
      if (image === newImage && failure === "uncertain-selection") throw new Error("selection response lost");
      return "";
    }
    if (words.includes("restart")) {
      if (selected.image === newImage && failure === "cancel") controller.abort(new Error("cancelled"));
      options.signal?.throwIfAborted();
      if (selected.image === oldImage && failure === "rollback") throw new Error("rollback restart failed");
      if (selected.image === oldImage && failure === "rollback-deadline") clock += 181000;
      running = { ...selected };
      if (selected.image === newImage) firstRestartCompleted = true;
      return "";
    }
    if (words.includes("status")) {
      if (failure === "starting") throw new Error("OpenRC status: starting");
      return "started";
    }
    if (words.includes("inspect") && words.includes("image")) {
      if (failure === "missing-image") throw new Error("no such image");
      return `image-id-of-${words.at(-1)}`;
    }
    if (words.includes("inspect")) return `${running.image} ${failure === "retagged" ? "different-image-id" : `image-id-of-${running.image}`}`;
    if (words.includes("exec")) return String(running.version);
    if (words.includes("wait")) return "";
    throw new Error(`unexpected command ${file} ${words.join(" ")}`);
  };
  return {
    calls, progress, state: () => ({ selected, running }), firstRestartCompleted: () => firstRestartCompleted,
    deploy: () => deployStats({ mode, host: "fixture", base: "https://stats.example", run, report: (message: string) => progress.push(message), now: () => clock, wait: async (ms: number) => { clock += ms; }, signal: controller.signal })
  };
}

await test("Orange deploy verifies the release and runs the complete smoke once", async () => {
  const f = fixture();
  assert.deepEqual(await f.deploy(), { image: newImage, version: 2 });
  assert.deepEqual(f.state(), { selected: { image: newImage, version: 2 }, running: { image: newImage, version: 2 } });
  assert.equal(f.calls.filter(call => call.file.endsWith("deployed-smoke.sh")).length, 1);
  assert.match(f.progress.join("\n"), /build and transfer[\s\S]*restart[\s\S]*public health[\s\S]*API and dashboard[\s\S]*record verified/u);
});

await test("redeploying the current image retains the host's existing node version", async () => {
  const f = fixture("current");
  assert.deepEqual(await f.deploy(), { image: newImage, version: 2 });
  assert.deepEqual(f.state().selected, f.state().running);
});

for (const failure of ["smoke", "health", "cancel"]) await test(`Orange deploy restores image and node version after ${failure}`, async () => {
  const f = fixture(failure);
  await assert.rejects(f.deploy());
  assert.deepEqual(f.state(), { selected: { image: oldImage, version: 3 }, running: { image: oldImage, version: 3 } });
  assert.match(f.progress.at(-1)!, /previous Stats image and runtime node version verified/u);
  if (failure === "cancel") {
    assert.equal(f.firstRestartCompleted(), true);
  }
});

await test("a lost selection acknowledgement does not authorize overwriting an uncertain owner", async () => {
  const f = fixture("uncertain-selection");
  await assert.rejects(f.deploy(), (error: unknown) => {
    const [primary, rollback] = deploymentFailureMessages(error);
    assert.equal(primary, "selection response lost"); assert.match(rollback, /ownership is uncertain/u); return true;
  });
  assert.deepEqual(f.state(), { selected: { image: newImage, version: 2 }, running: { image: oldImage, version: 1 } });
  assert.equal(f.calls.filter(call => call.words.includes("set-image")).length, 1);
});

await test("Orange deploy refuses existing drift before building or changing selection", async () => {
  const f = fixture("drift");
  await assert.rejects(f.deploy(), /differs from running/u);
  assert.equal(f.calls.some(call => call.file.endsWith("build-image.sh") || call.words.includes("set-image")), false);
});

for (const [failure, problem] of [
  ["fenced", /writer authority.*local deployment.*fenced/u],
  ["starting", /OpenRC status: starting/u],
  ["missing-image", /no such image/u],
  ["retagged", /differs from running/u]
] as const) await test(`Orange deploy refuses ${failure} state before a build or mutation`, async () => {
  const f = fixture(failure);
  await assert.rejects(f.deploy(), problem);
  assert.ok(f.calls.every(call => call.file === "ssh" && ["deployment", "status", "inspect", "exec"].some(word => call.words.includes(word))));
});

await test("Orange check mode only inspects the selected and running release", async () => {
  const f = fixture("none", "check"); await f.deploy();
  assert.deepEqual(f.state(), { selected: { image: oldImage, version: 1 }, running: { image: oldImage, version: 1 } });
  assert.ok(f.calls.every(call => call.file === "ssh" && ["deployment", "status", "inspect", "exec"].some(word => call.words.includes(word))));
  assert.match(f.progress.at(-1)!, /selected and running Stats release verified/u);
});

await test("Orange rollback leaves a concurrent deployment selected", async () => {
  const f = fixture("concurrent");
  await assert.rejects(f.deploy(), (error: unknown) => {
    const [primary, rollback] = deploymentFailureMessages(error);
    assert.equal(primary, "smoke failed"); assert.match(rollback, /another deployment/u); return true;
  });
  assert.equal(f.state().selected.image, "stats:cccccccccccc");
});

await test("Orange rollback rejects an observed competing version of the same image", async () => {
  const f = fixture("concurrent-same");
  await assert.rejects(f.deploy(), (error: unknown) => { assert.match(deploymentFailureMessages(error)[1], /another deployment/u); return true; });
  assert.deepEqual(f.state().selected, { image: newImage, version: 4 });
  assert.equal(f.calls.filter(call => call.words.includes("set-image")).length, 1);
});

await test("Orange deploy retains the primary failure when rollback fails", async () => {
  const f = fixture("rollback");
  await assert.rejects(f.deploy(), (error: unknown) => { assert.deepEqual(deploymentFailureMessages(error), ["smoke failed", "rollback restart failed"]); return true; });
  assert.doesNotMatch(f.progress.at(-1)!, /previous Stats image.*verified/u);
});

await test("a failed marker does not roll back a verified healthy release", async () => {
  const f = fixture("marker");
  await assert.rejects(f.deploy(), /marker failed/u);
  assert.deepEqual(f.state().selected, f.state().running);
  assert.equal(f.state().selected.image, newImage);
  assert.equal(f.calls.filter(call => call.words.includes("set-image")).length, 1);
});

await test("rollback stops issuing commands after its total deadline", async () => {
  const f = fixture("rollback-deadline");
  await assert.rejects(f.deploy(), (error: unknown) => { assert.match(deploymentFailureMessages(error)[1], /rollback exceeded/u); return true; });
  assert.equal(f.calls.some(call => call.words.includes("wait")), false);
  assert.doesNotMatch(f.progress.at(-1)!, /previous Stats image.*verified/u);
});

await test("Orange deploy help and usage errors work offline", () => {
  const entry = join(root, "deploy/orange/deploy.mts");
  const help = spawnSync(process.execPath, [entry, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /usage:[\s\S]*Examples:[\s\S]*Rollback: 180s/u);
  assert.match(help.stdout, /Maintained by Joshua Li: https:\/\/github.com\/joshuarli\/stats/u);
  const checkHelp = spawnSync(process.execPath, [entry, "--check", "--help"], { encoding: "utf8" });
  assert.equal(checkHelp.status, 0, checkHelp.stderr);
  assert.equal(checkHelp.stdout, help.stdout);
  const invalid = spawnSync(process.execPath, [entry, "--unknown"], { encoding: "utf8" });
  assert.equal(invalid.status, 2); assert.match(invalid.stderr, /--help/u);
});

await test("a command deadline terminates and joins the owned process", async () => {
  await assert.rejects(runCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 100, output() {} }), /deadline/u);
});

await test("deployment logging rejects a symlink before contacting the host", () => {
  const directory = mkdtempSync(join(root, ".work/tmp/orange-log-"));
  try {
    const target = join(directory, "preserve.txt");
    writeFileSync(target, "preserve");
    symlinkSync(target, join(directory, "worker-deploy.log"));
    const result = spawnSync(process.execPath, [join(root, "deploy/orange/deploy.mts"), "--check", "fixture"], { encoding: "utf8", env: { ...process.env, STEP_LOG_DIR: directory } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ELOOP/u);
    assert.equal(readFileSync(target, "utf8"), "preserve");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

await test("commands preserve success, exit failure and cancellation identity", async () => {
  const options = { timeoutMs: 2000, output() {} };
  assert.equal(await runCommand(process.execPath, ["-e", "console.log('ok')"], options), "ok");
  await assert.rejects(runCommand(process.execPath, ["-e", "process.exit(7)"], options), /exited 7/u);
  const controller = new AbortController(), reason = new Error("already cancelled");
  controller.abort(reason);
  await assert.rejects(runCommand(process.execPath, [], { ...options, signal: controller.signal }), error => error === reason);
});

await test("cancellation allows a live leader to finish graceful cleanup", { timeout: 10000 }, async () => {
  const controller = new AbortController(), reason = new Error("cancel");
  let output = "";
  const script = "process.on('SIGTERM',()=>{console.log('cleaned');process.exit(0)});console.log('ready');setInterval(()=>{},1000)";
  await assert.rejects(runCommand(process.execPath, ["-e", script], {
    timeoutMs: 2000, signal: controller.signal, output(chunk) {
      output += chunk;
      if (output.includes("ready")) controller.abort(reason);
    }
  }), error => error === reason);
  assert.match(output, /cleaned/u);
});

function processState(pid: number): string {
  if (process.platform === "linux") {
    try {
      const match = /^\d+ \(.+\) ([A-Z]) /u.exec(readFileSync(`/proc/${pid}/stat`, "utf8"));
      assert.ok(match); return match[1]!;
    } catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return ""; throw error; }
  }
  return spawnSync("/bin/ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" }).stdout.trim();
}

function killOwnedDescendant(pid: number) {
  const state = processState(pid);
  if (state === "" || state.startsWith("Z")) return;
  try { process.kill(pid, "SIGKILL"); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
}

await test("command cancellation also terminates an owned grandchild", { timeout: 10000 }, async () => {
  const controller = new AbortController(), cancelled = new Error("cancel process tree");
  let descendant: number | undefined, output = "";
  const failures: unknown[] = [];
  try {
    const grandchild = "process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)";
    const leader = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:['ignore','pipe','ignore']});child.stdout.once('data',()=>console.log(child.pid));setInterval(()=>{},1000);`;
    await assert.rejects(runCommand(process.execPath, ["-e", leader], {
      timeoutMs: 2000, signal: controller.signal, output(chunk) {
        output += chunk;
        if (output.includes("\n")) { descendant = Number(output.trim()); controller.abort(cancelled); }
      }
    }), error => error === cancelled);
    assert.ok(descendant !== undefined);
    const until = performance.now() + 5500;
    let state = processState(descendant);
    while (state !== "" && !state.startsWith("Z") && performance.now() < until) {
      await new Promise(resolveWait => setTimeout(resolveWait, 25));
      state = processState(descendant);
    }
    assert.ok(state === "" || state.startsWith("Z"), `grandchild ${descendant} remains active: ${state}`);
  } catch (error) { failures.push(error); }
  if (descendant !== undefined) { try { killOwnedDescendant(descendant); } catch (error) { failures.push(error); } }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "process-tree assertion and cleanup failed");
});

for (const during of ["smoke", "restart"] as const) for (const signal of ["SIGHUP", "SIGINT", "SIGTERM", "SIGQUIT"] as const) await test(`Orange cancellation during ${during} completes rollback and dies by ${signal}`, { timeout: 15000 }, async () => {
  const directory = mkdtempSync(join(root, ".work/tmp/orange-cancel-"));
  let child: ChildProcessByStdio<null, Readable, Readable> | undefined;
  try {
    const app = join(directory, "deploy/orange"), bin = join(directory, "bin"), state = join(directory, "state.json"), blocked = join(directory, "blocked");
    mkdirSync(app, { recursive: true }); mkdirSync(bin);
    writeFileSync(join(directory, "package.json"), JSON.stringify({ type: "commonjs" }));
    for (const file of ["command.mts", "deploy.mts"]) copyFileSync(join(root, "deploy/orange", file), join(app, file));
    writeFileSync(state, JSON.stringify({ selected: { image: oldImage, version: 1 }, running: { image: oldImage, version: 1 } }));
    writeFileSync(join(app, "build-image.sh"), `#!/bin/sh\necho ${newImage}\n`, { mode: 0o755 });
    writeFileSync(join(directory, "deploy/deployed-smoke.sh"), `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.BLOCKED,'ready');setInterval(()=>{},1000);\n`, { mode: 0o755 });
    writeFileSync(join(bin, "curl"), "#!/bin/sh\necho '{}'\n", { mode: 0o755 });
    writeFileSync(join(bin, "ssh"), `#!${process.execPath}
const fs=require('node:fs'),path=process.env.STATE,s=JSON.parse(fs.readFileSync(path));
const a=[...process.argv.at(-1).matchAll(/'([^']*)'/g)].map(m=>m[1]);
if(a.includes('deployment')) console.log(JSON.stringify(s.selected));
else if(a.includes('set-image')) {const i=a.indexOf('set-image');if(a.at(-1)!==s.selected.image)process.exit(1);s.selected={image:a[i+2],version:s.selected.version+1};}
else if(a.includes('restart')) {
  if(process.env.BLOCK_DURING==='restart' && s.selected.image==='${newImage}') {
    const watcher=fs.watch(require('node:path').dirname(process.env.BLOCKED),(_event,name)=>{
      if(name==='release') {s.running={...s.selected};s.firstRestartCompleted=true;fs.writeFileSync(path,JSON.stringify(s));watcher.close();}
    });
    fs.writeFileSync(process.env.BLOCKED,'ready');
  } else s.running={...s.selected};
}
else if(a.includes('inspect')&&a.includes('image')) console.log('image-id-of-'+a.at(-1));
else if(a.includes('inspect')) console.log(s.running.image+' image-id-of-'+s.running.image);
else if(a.includes('status')) console.log('started');
else if(a.includes('exec')) console.log(s.running.version);
fs.writeFileSync(path,JSON.stringify(s));
`, { mode: 0o755 });
    child = spawn(process.execPath, [join(app, "deploy.mts"), "fixture"], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, STATE: state, BLOCKED: blocked, BLOCK_DURING: during }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
    const closed = new Promise(resolveDone => child!.once("close", (code, death) => resolveDone({ code, death })));
    const { watch } = await import("node:fs/promises");
    const watching = watch(directory, { signal: AbortSignal.timeout(5000) });
    try {
      while (true) {
        const event = await Promise.race([watching.next(), closed.then((): never => { throw new Error(`deployment exited before the blocked smoke: ${output}`); })]);
        if (event.value?.filename === "blocked") {
          child.kill(signal);
          if (during === "restart") writeFileSync(join(directory, "release"), "finish restart");
          break;
        }
      }
    } finally { await watching.return?.(); }
    assert.deepEqual(await closed, { code: null, death: signal }, output);
    const result: unknown = JSON.parse(readFileSync(state, "utf8"));
    assert.deepEqual(result, { selected: { image: oldImage, version: 3 }, running: { image: oldImage, version: 3 }, ...(during === "restart" ? { firstRestartCompleted: true } : {}) });
    assert.match(output, /previous Stats image and runtime node version verified/u);
    assert.match(readFileSync(join(directory, ".work/tmp/steps/worker-deploy.log"), "utf8"), /cancelled by/u);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    rmSync(directory, { recursive: true, force: true });
  }
});
