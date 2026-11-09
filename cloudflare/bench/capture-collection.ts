import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseProjects } from "../src/projects/config.ts";
import { windowStartMs } from "../src/projects/metrics.ts";
import { type BoundQuery, d1Query, d1StatementQuery, d1StorageQuery, durableObjectQuery, r2OperationsQuery, r2StorageQuery, routeQuery, workerQuery } from "../src/projects/queries.ts";
import { CLOUDFLARE_ROOT } from "../local/topology.ts";
import { replayKey, type CollectionFixture } from "./collection-replay.ts";

const OUTPUT = join(CLOUDFLARE_ROOT, "bench/fixtures/collection.json");
const LABEL = /^([A-Z]+) (\/\S*)$/u;

function cf(args: readonly string[]): unknown {
  const run = spawnSync("cf", ["-q", ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(`cf ${args.slice(0, 2).join(" ")} failed: ${run.stderr || run.stdout}`);
  return JSON.parse(run.stdout);
}

function token(value: string, alphabet: string, length: number): string {
  const digest = createHash("sha256").update(value).digest();
  let out = "";
  for (let index = 0; out.length < length; index += 1) out += alphabet[digest[index % digest.length]! % alphabet.length];
  return out;
}

function pseudonymousSegment(segment: string): string {
  if (segment === "" || /^v\d+$/u.test(segment)) return segment;
  const length = Math.max(1, Math.min(segment.length, 40));
  const letters = token(segment, "abcdefghijklmnopqrstuvwxyz", length);
  return /\d/u.test(segment) ? `${letters.slice(0, -1)}${token(segment, "0123456789", 1)}` : letters;
}

function pseudonymousLabel(label: string): string {
  const match = LABEL.exec(label);
  if (match === null) return label;
  const path = (match[2] ?? "").split("?")[0]!;
  return `${match[1]} ${path.split("/").map(pseudonymousSegment).join("/")}`;
}

function pseudonymousStatement(statement: string): string {
  return `stmt_${token(statement, "0123456789abcdef", 12)} ${"x".repeat(Math.max(0, statement.length - 18))}`;
}

function scrub(rows: readonly unknown[]): unknown[] {
  return rows.map(row => {
    const record = { ...(row as Record<string, unknown>) };
    if (typeof record["invocationLabel"] === "string") record["invocationLabel"] = pseudonymousLabel(record["invocationLabel"]);
    if (typeof record["statement"] === "string") record["statement"] = pseudonymousStatement(record["statement"]);
    return record;
  });
}

const built = JSON.parse(readFileSync(join(CLOUDFLARE_ROOT, ".cloudflare/output/v0/workers/default/worker.config.json"), "utf8")) as { env: { PROJECTS: { value: string } } };
const projectsJson = built.env.PROJECTS.value;
const accounts = cf(["accounts", "list"]) as { id: string }[];
if (accounts.length !== 1) throw new Error("the cf profile must see exactly one account");
const accountTag = process.env["CLOUDFLARE_ACCOUNT_ID"] ?? accounts[0]!.id;
const capturedAtMs = Date.now();
const startMs = windowStartMs(capturedAtMs);
const responses: Record<string, CollectionFixture["responses"][string]> = {};
for (const project of parseProjects(projectsJson)) {
  const bounds: BoundQuery[] = [workerQuery(project.worker, startMs), routeQuery(project.worker, startMs)];
  if (project.durableObjectNamespaces.length > 0) bounds.push(durableObjectQuery(project.durableObjectNamespaces, startMs));
  if (project.buckets.length > 0) bounds.push(r2OperationsQuery(project.buckets, startMs), r2StorageQuery(project.buckets, startMs));
  if (project.d1Databases.length > 0) bounds.push(d1Query(project.d1Databases, startMs), d1StatementQuery(project.d1Databases, startMs), d1StorageQuery(project.d1Databases, startMs));
  for (const bound of bounds) {
    const body = JSON.stringify({ query: bound.query, params: bound.params, scope: { accountTag } });
    const result = cf(["sql", "query", "-", "--body", body]) as { data: unknown[]; statistics: { rows_read: number } };
    responses[replayKey(bound)] = { data: scrub(result.data), rowsRead: result.statistics.rows_read };
  }
}
const fixture: CollectionFixture = { capturedAtMs, projectsJson, responses };
writeFileSync(OUTPUT, `${JSON.stringify(fixture)}\n`);
const rows = Object.values(responses).reduce((total, response) => total + response.data.length, 0);
console.log(`${Object.keys(responses).length} queries, ${rows} rows -> ${OUTPUT}`);
