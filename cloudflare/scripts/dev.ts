import { watch, existsSync, lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { constants } from "node:os";
import solid from "@solidjs/vite-plugin";
import { createServer, type Connect } from "vite";
import type { BackendMessage, BackendReady, BackendStart } from "../local/dev-backend.ts";
import { ensureBuilds, ROOT, type BuiltArtifact } from "./ensure-build.ts";
import { runtimeVersions } from "./dev-doctor.ts";
import { acquireOwnership } from "./ownership.ts";
import { processOwner } from "./processes.ts";

export async function runDev(args = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({ args, options: { state: { type: "string", default: resolve(ROOT, "../.work/local/state") }, port: { type: "string", default: "0" }, reset: { type: "boolean" }, producer: { type: "string", multiple: true }, "producer-worker": { type: "string", multiple: true }, service: { type: "string", multiple: true }, "producer-var": { type: "string", multiple: true } } });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be 0..65535");
  const state = resolve(values.state);
  const work = resolve(ROOT, "../.work");
  mkdirSync(work, { recursive: true });
  mkdirSync(resolve(state, ".."), { recursive: true });
  const parent = realpathSync(resolve(state, ".."));
  if ((parent !== realpathSync(work) && !parent.startsWith(`${realpathSync(work)}${sep}`)) || !state.startsWith(`${work}${sep}`) || (existsSync(state) && lstatSync(state).isSymbolicLink())) throw new Error("development state must be inside this checkout's .work directory without a state symlink");
  if (values.producer?.length || values["producer-worker"]?.length || values.service?.length || values["producer-var"]?.length) throw new Error("producer options require node cloudflare/scripts/local-stack.mjs dev --producer DIR");
  const versions = runtimeVersions();
  const controller = new AbortController();
  const owner = processOwner("dev", { signals: false });
  const signals: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  const terminate = (signal: NodeJS.Signals): void => { process.exitCode = 128 + constants.signals[signal]; controller.abort(); };
  for (const signal of signals) process.on(signal, terminate);
  let release: (() => void) | undefined;
  const statusFile = join(owner.directory, "status.json");
  const watchers: ReturnType<typeof watch>[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let runtime: ReturnType<typeof owner.start> | undefined;
  let backend: BackendReady | undefined;
  let frontend: Awaited<ReturnType<typeof createServer>> | undefined;
  let revision = 0;
  let loading = false;
  let pending: Promise<void> | undefined;
  let activeArtifacts: BuiltArtifact[] = [];
  let ready = false;
  let fatal: unknown;
  const status = (event: string, extra: Record<string, unknown> = {}): void => {
    const origin = frontend?.resolvedUrls?.local[0]?.replace(/\/$/u, "");
    const record = { event, runId: owner.directory.split(sep).at(-1), pid: process.pid, backendPid: backend?.pid, state, statusFile, origin, backendOrigin: backend?.origin, workerOrigin: backend?.workerOrigin, ports: { frontend: origin === undefined ? null : Number(new URL(origin).port), backend: backend === undefined ? null : Number(new URL(backend.origin).port) }, artifacts: activeArtifacts.map(artifact => ({ target: artifact.target, identity: artifact.identity, output: artifact.output })), runtimes: versions.map(runtime => ({ consumer: runtime.consumer, miniflare: runtime.miniflare.version, workerd: runtime.workerd.version })), ...extra };
    writeFileSync(statusFile, JSON.stringify(record));
    console.log(JSON.stringify(record));
  };
  const stopBackend = async (): Promise<void> => {
    const previous = runtime;
    runtime = undefined;
    backend = undefined;
    if (previous === undefined) return;
    if (previous.child.connected) previous.child.send("shutdown");
    const deadline = setTimeout(() => previous.kill("SIGKILL"), 10_000);
    try { await previous.done; } finally { clearTimeout(deadline); }
  };
  const activate = async (artifacts: BuiltArtifact[], initialize: boolean): Promise<void> => {
    status("dev-reloading");
    backend = undefined;
    controller.signal.throwIfAborted();
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:CLOUDFLARE_|CF_)/u.test(name)));
    const child = runtime ?? owner.start("backend", process.execPath, [join(ROOT, "local/dev-backend.ts")], { cwd: ROOT, env: { ...env, CLOUDFLARE_DEV_REGISTRY_PATH: join(owner.directory, "registry") }, ipc: true });
    if (runtime === undefined) void child.done.then(() => {
      if (runtime === child && !controller.signal.aborted) { fatal = new Error("active backend exited"); controller.abort(); }
    }, error => { if (runtime === child && !controller.signal.aborted) { fatal = error; controller.abort(); } });
    runtime = child;
    const options: BackendStart = { state, statsOutput: join(artifacts.find(artifact => artifact.target === "stats")!.output, "v0/workers/default"), observeOutput: join(artifacts.find(artifact => artifact.target === "observe")!.output, "v0/workers/default"), initialize };
    const timeout = setTimeout(() => child.kill("SIGKILL"), 120_000);
    try {
      backend = await Promise.race([
        new Promise<BackendReady>((done, reject) => {
          child.child.once("message", (message: BackendMessage) => {
            if (message.event === "backend-ready") done(message);
            else reject(new Error("backend activation failed; see the backend log"));
          });
          child.child.send(options, error => { if (error !== null) reject(error); });
        }),
        child.done.then((): never => { throw new Error("backend exited before readiness"); })
      ]);
    } finally { clearTimeout(timeout); }
    controller.signal.throwIfAborted();
    activeArtifacts = artifacts;
    if (ready) status("dev-ready", { producers: backend.producers });
  };
  const reload = async (): Promise<void> => {
    if (loading || controller.signal.aborted) return;
    loading = true;
    try {
      let requested;
      do {
        requested = revision;
        let artifacts;
        try { artifacts = await ensureBuilds(["stats", "observe"], { signal: controller.signal }); }
        catch (error) {
          if (!controller.signal.aborted) { console.error(error); status("dev-build-error", { message: "compilation failed; serving the previous generation" }); }
          if (requested !== revision && !controller.signal.aborted) continue;
          return;
        }
        if (requested !== revision) continue;
        if (backend !== undefined && artifacts.every(artifact => activeArtifacts.some(active => active.target === artifact.target && active.identity === artifact.identity))) { status("dev-ready", { producers: backend.producers }); return; }
        try { await activate(artifacts, false); }
        catch (error) { if (!controller.signal.aborted) { console.error(error); status("dev-activation-error", { message: "backend unavailable; fix and edit to retry; persistent state was retained" }); } }
      } while (requested !== revision && !controller.signal.aborted);
    } finally { loading = false; }
  };
  const proxy: Connect.NextHandleFunction = (incoming, outgoing, next) => {
    if (!/^\/(?:api(?:\/|$)|ingest(?:\/|$)|health(?:\?|$)|docs(?:\/|$))/u.test(incoming.url ?? "")) { next(); return; }
    const current = backend;
    if (current === undefined) { outgoing.writeHead(503, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { code: "backend_reloading", message: "Local backend is restarting" } })); return; }
    const target = new URL(current.origin);
    const proxied = request({ hostname: target.hostname, port: target.port, method: incoming.method, path: incoming.url, headers: { ...incoming.headers, host: target.host } }, response => { outgoing.writeHead(response.statusCode ?? 502, response.headers); response.pipe(outgoing); });
    proxied.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end("Local backend unavailable"); });
    incoming.on("aborted", () => proxied.destroy());
    outgoing.on("close", () => proxied.destroy());
    incoming.pipe(proxied);
  };
  try {
    release = await acquireOwnership(`${state}.sqlite`, controller.signal, 1000);
    if (values.reset) { rmSync(state, { recursive: true, force: true }); status("dev-reset"); return; }
    mkdirSync(state, { recursive: true });
    const artifacts = await ensureBuilds(["stats", "observe"], { signal: controller.signal });
    await activate(artifacts, true);
    frontend = await createServer({ root: ROOT, configFile: false, envDir: false, cacheDir: join(owner.directory, "vite"), plugins: [solid(), { name: "offline-api", configureServer(server) { server.middlewares.use(proxy); } }], server: { host: "127.0.0.1", port, strictPort: true, fs: { allow: [ROOT, resolve(ROOT, "../node_modules")] } } });
    await frontend.listen();
    const changed = (path: string): void => {
      if (path.startsWith("src/client/")) return;
      if (!/^(?:src\/|observe-worker\/(?:cloudflare|vite)\.config\.ts$|(?:cloudflare|vite)\.config\.ts$|(?:pnpm-lock\.yaml|pnpm-workspace\.yaml|package\.json|\.node-version)$)/u.test(path)) return;
      revision += 1;
      clearTimeout(timer);
      timer = setTimeout(() => { if (!loading) pending = reload(); }, 100);
    };
    for (const [directory, prefix, recursive] of [[join(ROOT, "src"), "src/", true], [join(ROOT, "observe-worker"), "observe-worker/", false], [ROOT, "", false], [resolve(ROOT, ".."), "", false]] as const) {
      const watcher = watch(directory, { recursive }, (_event, file) => { if (file !== null) changed(prefix + file); });
      watcher.on("error", error => { fatal = error; controller.abort(); });
      watchers.push(watcher);
    }
    ready = true;
    console.log(`stats local stack: ${frontend.resolvedUrls!.local[0]}  (state ${state}, frontend HMR and automatic backend reload)`);
    for (const producer of backend!.producers) console.log(`producer ${producer.service}: ${producer.origin}`);
    status("dev-ready", { producers: backend!.producers });
    console.log("ready");
    await new Promise<void>(done => { if (controller.signal.aborted) done(); else controller.signal.addEventListener("abort", () => done(), { once: true }); });
    if (fatal !== undefined) throw fatal;
  } finally {
    controller.abort();
    clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
    await pending;
    await frontend?.close();
    await stopBackend().catch(error => console.error(error));
    await owner.close();
    release?.();
    for (const signal of signals) process.off(signal, terminate);
    status("dev-stopped");
  }
}

if (import.meta.main) {
  try { await runDev(); } catch (error) { console.error(error); process.exitCode ||= 1; }
}
