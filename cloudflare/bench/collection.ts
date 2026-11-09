import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runCollector } from "../src/cloudflare/projects/collector.ts";
import { openNodeInstallation, type NodeInstallation } from "../src/node/installation.ts";
import { parseProjects, type ProjectConfig } from "../src/projects/config.ts";
import { CLOUDFLARE_ROOT } from "../local/topology.ts";
import { type CollectionFixture, recordedProbe, replayAnalytics } from "./collection-replay.ts";

const FIXTURE = JSON.parse(readFileSync(join(CLOUDFLARE_ROOT, "bench/fixtures/collection.json"), "utf8")) as CollectionFixture;
const RUN_MS = 90 * 60_000;
const WEEK_RUNS = (7 * 24 * 60 * 60_000) / RUN_MS;
const HEAVY_COPIES = 10;
const SAMPLES = Number(process.env["BENCH_SAMPLES"] ?? "15");
const WORK = join(CLOUDFLARE_ROOT, "../.work/tmp/bench-collection");

type Tier = "small" | "production" | "heavy";

function tierProjects(tier: Tier): string {
  const projects = parseProjects(FIXTURE.projectsJson);
  if (tier === "small") return JSON.stringify(projects.filter(project => project.id === "stats"));
  if (tier === "production") return FIXTURE.projectsJson;
  const copies: ProjectConfig[] = [];
  for (let copy = 0; copy < HEAVY_COPIES; copy += 1) for (const project of projects) copies.push({ ...project, id: copy === 0 ? project.id : `${project.id.slice(0, 26)}-c${copy}` });
  return JSON.stringify(copies);
}

function cpuMs<T>(work: () => Promise<T>): Promise<{ value: T; cpuMs: number }> {
  const before = process.cpuUsage();
  return work().then(value => {
    const used = process.cpuUsage(before);
    return { value, cpuMs: (used.user + used.system) / 1000 };
  });
}

function open(tier: Tier, clock: { now: number }): NodeInstallation {
  const directory = join(WORK, `${tier}-${process.pid}`);
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  return openNodeInstallation({ path: join(directory, "stats.sqlite"), projects: tierProjects(tier), clock: { now: () => clock.now }, probeFetch: recordedProbe });
}

async function collect(installation: NodeInstallation, projectsJson: string, nowMs: number, offsetMs: number): Promise<number> {
  const result = await runCollector({ analytics: replayAnalytics(FIXTURE, offsetMs), store: installation.core, projectsJson, storeWorker: "stats", now: nowMs, probeFetch: recordedProbe });
  return result.metricRowsWritten;
}

function summary(values: readonly number[]): string {
  const sorted = [...values].sort((left, right) => left - right);
  return `${sorted[Math.floor(sorted.length / 2)]!.toFixed(2)} [${sorted[0]!.toFixed(2)}-${sorted.at(-1)!.toFixed(2)}]`;
}

function historyPath(project: ProjectConfig, range: string): string {
  const kinds = ["worker", "routes", "r2", "collector"];
  if (project.durableObjectNamespaces.length > 0) kinds.push("durable-objects");
  if (project.d1Databases.length > 0) kinds.push("d1", "d1-statements");
  if (project.probes.length > 0) kinds.push("probes");
  return `https://stats.local/projects/${project.id}/history?range=${range}&kinds=${kinds.join(",")}`;
}

async function benchTier(tier: Tier): Promise<void> {
  const clock = { now: FIXTURE.capturedAtMs };
  const installation = open(tier, clock);
  const projectsJson = tierProjects(tier);
  try {
    for (let run = WEEK_RUNS - 1; run >= 1; run -= 1) {
      clock.now = FIXTURE.capturedAtMs - run * RUN_MS;
      await collect(installation, projectsJson, clock.now, run * RUN_MS);
    }
    clock.now = FIXTURE.capturedAtMs;
    const cold = await cpuMs(() => collect(installation, projectsJson, clock.now, 0));
    const steady: number[] = [];
    let rowsWritten = 0;
    for (let sample = 0; sample < SAMPLES; sample += 1) {
      const measured = await cpuMs(() => collect(installation, projectsJson, clock.now, 0));
      steady.push(measured.cpuMs);
      rowsWritten = measured.value;
    }
    const projects = parseProjects(projectsJson).length;
    console.log(`${tier} | ${projects} projects | collection new window ${cold.cpuMs.toFixed(2)} ms (${cold.value} rows written) | collection repeat ${summary(steady)} ms (${rowsWritten} rows written)`);
    const stuff = parseProjects(projectsJson).find(project => project.id === "stuff");
    const project = stuff ?? parseProjects(projectsJson)[0]!;
    for (const range of ["1h", "24h", "7d"]) {
      const times: number[] = [];
      let bytes = 0;
      for (let sample = 0; sample < SAMPLES; sample += 1) {
        const measured = await cpuMs(async () => {
          const response = await installation.core.fetch(new Request(historyPath(project, range), { headers: { accept: "application/vnd.stats.history" } }));
          if (response.status !== 200) throw new Error(`history ${range} answered ${response.status}: ${await response.text()}`);
          return (await response.arrayBuffer()).byteLength;
        });
        times.push(measured.cpuMs);
        bytes = measured.value;
      }
      console.log(`${tier} | history ${project.id} ${range} | ${summary(times)} ms CPU | ${bytes} bytes`);
    }
  } finally {
    installation.close();
  }
}

console.log(`node ${process.version}, ${process.platform}/${process.arch}; fixture captured ${new Date(FIXTURE.capturedAtMs).toISOString()}; ${WEEK_RUNS} seeded 90-minute collections; ${SAMPLES} samples; CPU ms median [min-max]`);
for (const tier of (process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["small", "production", "heavy"]) as Tier[]) await benchTier(tier);
