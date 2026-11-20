import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve, join } from "node:path";

const image = "node@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5";
const repo = resolve(import.meta.dirname, "../../..");
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function startContainerSession(stateDir: string, port: number, runtimeRoot: string) {
  const name = `stats-canary-${randomBytes(8).toString("hex")}`;
  const mounts = [repo, stateDir, runtimeRoot].map((path, i) => ["--mount", `type=bind,src=${path},dst=${path}${i === 1 ? "" : ",readonly"}`]).flat();
  const args = ["run", "--rm", "--platform", "linux/amd64", "--name", name, ...mounts, "-w", stateDir, "-p", `127.0.0.1:${port}:${port}`, image, "node", join(runtimeRoot, "node_modules/open-orange/dist/bin.js"), "dev", "--json", "--ip", "0.0.0.0", "--port", String(port), "--config", join(stateDir, "stats.jsonc"), "--config", join(stateDir, "observe.jsonc")];
  const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
  const logs: string[] = [];
  let ready = false;
  const started = performance.now();
  child.stdout!.on("data", (chunk: Buffer) => { for (const line of chunk.toString("utf8").split("\n")) { logs.push(line); try { if (JSON.parse(line).type === "ready") ready = true; } catch {} } });
  child.stderr!.on("data", (chunk: Buffer) => logs.push(chunk.toString("utf8")));
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    spawnSync("docker", ["stop", "-t", "10", name], { encoding: "utf8" });
    if (child.exitCode === null && child.signalCode === null) await new Promise<void>(done => child.once("exit", () => done()));
  };
  while (!ready && child.exitCode === null && performance.now() - started < 180_000) await delay(100);
  if (!ready) { await stop(); throw new Error(`container failed: ${logs.slice(-20).join("\n")}`); }
  return { origin: `http://127.0.0.1:${port}`, child, readyMs: Math.round(performance.now() - started), logs, stop, containerName: name };
}
