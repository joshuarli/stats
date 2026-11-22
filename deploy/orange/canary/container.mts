import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { freePort } from "../session.mts";

const image = "node@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5";
const repo = resolve(import.meta.dirname, "../../..");
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** `appRoot`, when given, is the app release the stack serves; it may live outside the repository, for example on tmpfs. */
export async function startContainerSession(stateDir: string, port: number, runtimeRoot: string, appRoot?: string) {
  const name = `stats-canary-${randomBytes(8).toString("hex")}`;
  const engineDir = join(stateDir, "engine");
  mkdirSync(join(engineDir, "log"), { recursive: true });
  const config = join(engineDir, "config.json");
  writeFileSync(config, JSON.stringify({ topology: { datacenter_label: 1, datacenters: { default: { datacenter_label: 1, is_leader: true, peer_url: "http://127.0.0.1:6542/", public_url: "http://127.0.0.1:6543/" } } } }));
  const token = randomBytes(24).toString("hex");
  let metricsPort = await freePort();
  while (metricsPort === 65535) metricsPort = await freePort();
  const statsConfig = join(stateDir, "stats.jsonc");
  const descriptor = JSON.parse(readFileSync(statsConfig, "utf8"));
  const workerSecrets = ["GATEWAY_SECRET", "INFRA_METRICS_TOKEN_SHA256"].flatMap(name => descriptor.vars[name] === undefined ? [] : [[name, descriptor.vars[name]]]);
  for (const [name] of workerSecrets) delete descriptor.vars[name];
  writeFileSync(statsConfig, JSON.stringify(descriptor), { mode: 0o600 });
  const envFile = join(stateDir, "engine.env");
  writeFileSync(envFile, [`ORANGE_WORKER_SECRETS=${workerSecrets.map(([name]) => name).join(",")}`, ...workerSecrets.map(([name, value]) => `${name}=${value}`), "RIVET__API_PEER__HOST=127.0.0.1", "RIVET__API_PEER__PORT=6542", `RIVET__AUTH__ADMIN_TOKEN=${token}`, "RIVET__GUARD__HOST=127.0.0.1", "RIVET__GUARD__PORT=6543", "RIVET__METRICS__HOST=127.0.0.1", "RIVET__METRICS__PORT=6544", "RIVET__PEGBOARD__NODE_LOST_THRESHOLD=7000", `RIVET__OBJECT_STORAGE__PRIMARY__FILE_SYSTEM__PATH=${join(engineDir, "objects")}`, "RIVET__STORAGE__AUTO_PROVISION_PARTITIONS=1", "RIVET__STORAGE__BALANCING__ENABLED=false", "RIVET__STORAGE__COLD_STORE__DISK_CACHE_BYTES=0", `RIVET__STORAGE__LOG_DIRECTORY=${join(engineDir, "log")}`, "RIVET__STORAGE__LOG_SHARD__MAX_DISK_BYTES=1073741824", `RIVET_ENDPOINT=http://default:${token}@127.0.0.1:6543`, `RIVETKIT_METRICS_PORT=${metricsPort}`, `PORT=${port}`].join("\n") + "\n", { mode: 0o600 });
  const readonly = [repo, runtimeRoot, ...(appRoot === undefined ? [] : [resolve(appRoot)])];
  const mounts = [...readonly.map(path => ["--mount", `type=bind,src=${path},dst=${path},readonly`]), ["--mount", `type=bind,src=${stateDir},dst=${stateDir}`]].flat();
  const packages = readdirSync(join(runtimeRoot, "node_modules/.pnpm"));
  const arch = packages.some(entry => entry.startsWith("@rivetkit+engine-cli-linux-x64-musl@")) ? "amd64" : packages.some(entry => entry.startsWith("@rivetkit+engine-cli-linux-arm64-musl@")) ? "arm64" : undefined;
  if (arch === undefined) throw new Error("runtime lacks a Linux Engine binary");
  const engineName = `${name}-engine`;
  const engineShell = `engine=$(node -e 'const {createRequire}=require("module"); const r=createRequire(process.argv[1]+"/package.json"); const q=createRequire(r.resolve("rivetkit")); process.stdout.write(q("@rivetkit/engine-cli").getEnginePath())' "$1"); exec "$engine" --config "$2/engine/config.json"`;
  const engineArgs = ["run", "-d", "--rm", "--platform", `linux/${arch}`, "--name", engineName, ...mounts, "--env-file", envFile, "-w", stateDir, "-p", `127.0.0.1:${port}:${port}`, image, "sh", "-ec", engineShell, "canary", runtimeRoot, stateDir];
  const engine = spawnSync("docker", engineArgs, { encoding: "utf8" });
  if (engine.status !== 0) throw new Error(`engine failed: ${engine.stderr}`);
  const shell = `until node -e 'fetch("http://127.0.0.1:6543/actors/names?namespace=default",{headers:{authorization:"Bearer "+process.env.RIVET__AUTH__ADMIN_TOKEN}}).then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))'; do sleep 1; done; exec node "$1/node_modules/open-orange/dist/bin.js" serve --ip 0.0.0.0 --config "$2/stats.jsonc" --config "$2/observe.jsonc"`;
  const args = ["run", "--rm", "--platform", `linux/${arch}`, "--name", name, "--network", `container:${engineName}`, ...mounts, "--env-file", envFile, "-w", stateDir, image, "sh", "-ec", shell, "canary", runtimeRoot, stateDir];
  const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
  const logs: string[] = [];
  child.stdout!.on("data", (chunk: Buffer) => logs.push(chunk.toString("utf8")));
  child.stderr!.on("data", (chunk: Buffer) => logs.push(chunk.toString("utf8")));
  const started = performance.now();
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      spawnSync("docker", ["stop", "-t", "10", name], { encoding: "utf8" });
      if (child.exitCode === null && child.signalCode === null) await new Promise<void>(done => child.once("exit", () => done()));
    }
    spawnSync("docker", ["stop", "-t", "10", engineName], { encoding: "utf8" });
  };
  while (!logs.some(line => line.includes("orange serve listening on")) && child.exitCode === null && performance.now() - started < 180_000) await delay(100);
  if (!logs.some(line => line.includes("orange serve listening on"))) { await stop(); throw new Error(`container failed: ${logs.slice(-20).join("\n")}`); }
  return { origin: `http://127.0.0.1:${port}`, child, readyMs: Math.round(performance.now() - started), logs, stop, containerName: name, engineName, metricsPort };
}
