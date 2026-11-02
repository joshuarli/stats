import { Installation as HostInstallation } from "../installation";
import { PROJECT_SETTLE_MS } from "../limits";
import { windowStartMs } from "../projects/collector";
import type { CollectorRun } from "../projects/store";
import { parseProjects } from "../projects/config";
import { compareDeployment, comparisonBounds, DEPLOYMENT_BUCKET_MS, type ComparisonWindow, type MetricRow } from "./compare.ts";
import { deploymentsEnabled, type DeploymentPoll } from "./collector.ts";
import { UUID, type DeploymentHistory } from "./model.ts";
import { hasSettledWindow, rememberSettledWindow, initializeDeployments, purgeDeployments, readDeployments, readDeploymentSync, readVersions, saveDeploymentPoll } from "./store.ts";

/** Same exported class name, binding and object id; no new Durable Object namespace. */
export class Installation extends HostInstallation {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => { initializeDeployments(ctx.storage); });
  }

  private deploymentNow(): number {
    const value = this.env.ENVIRONMENT === "test" ? Number(this.env.TEST_NOW_MS) : Number.NaN;
    return Number.isSafeInteger(value) && value >= 0 ? value : Date.now();
  }

  async knownDeploymentVersions(project: string, worker: string): Promise<readonly string[]> {
    if (!parseProjects(this.env.PROJECTS).some(item => item.id === project && item.worker === worker)) throw new Error("unknown deployment project");
    return readVersions(this.ctx.storage.sql, project, worker).map(version => version.id);
  }

  async recordDeploymentPoll(poll: DeploymentPoll): Promise<void> {
    if (!parseProjects(this.env.PROJECTS).some(item => item.id === poll.project && item.worker === poll.worker)) throw new Error("unknown deployment project");
    if (!Number.isSafeInteger(poll.atMs) || poll.atMs < 0 || poll.deployments.length > 300 || poll.versions.length > 4) throw new Error("invalid deployment poll");
    saveDeploymentPoll(this.ctx.storage, poll);
    if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(this.deploymentNow() + 600_000);
  }

  override async recordCollectorRun(run: CollectorRun): Promise<{ metricRowsWritten: number }> {
    const result = await super.recordCollectorRun(run);
    if (run.ok) {
      try {
        const projects = parseProjects(this.env.PROJECTS);
        this.ctx.storage.transactionSync(() => {
          for (const entry of run.collected) {
            const project = projects.find(item => item.id === entry.project);
            if (project === undefined) continue;
            // The run timestamp includes collection duration. Skip its first bucket
            // conservatively so a run crossing a cron boundary cannot overclaim coverage.
            rememberSettledWindow(this.ctx.storage.sql, project.id, project.worker,
              windowStartMs(run.atMs) + DEPLOYMENT_BUCKET_MS,
              Math.floor((run.atMs - PROJECT_SETTLE_MS) / DEPLOYMENT_BUCKET_MS) * DEPLOYMENT_BUCKET_MS);
          }
        });
      } catch { console.error(JSON.stringify({ event: "deployment_coverage_unrecorded" })); }
    }
    return result;
  }

  override async alarm(): Promise<void> {
    try { purgeDeployments(this.ctx.storage.sql, this.deploymentNow()); }
    catch { console.error(JSON.stringify({ event: "deployment_retention_failed" })); }
    await super.alarm();
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const match = /^\/projects\/([a-z][a-z0-9-]{0,31})\/deployments(?:\/([0-9a-f-]{36})\/comparison)?$/i.exec(url.pathname);
    if (match === null) return super.fetch(request);
    try {
    const failure = (status: number, message: string) => Response.json({ error: { code: status === 404 ? "not_found" : status === 503 ? "unavailable" : "invalid_request", message } }, { status });
    if (request.method !== "GET") return failure(405, "method not allowed");
    let project;
    try { project = parseProjects(this.env.PROJECTS).find(item => item.id === match[1]); }
    catch { return failure(503, "project configuration unavailable"); }
    if (project === undefined) return failure(404, "project not found");
    const now = this.deploymentNow();
    const sql = this.ctx.storage.sql;
    const deployments = readDeployments(sql, project.id, project.worker, now);
    const sync = readDeploymentSync(sql, project.id, project.worker);
    const enabled = deploymentsEnabled(this.env);
    if (match[2] === undefined) {
      if ([...url.searchParams].length !== 0) return failure(400, "unexpected query parameters");
      const history: DeploymentHistory = { projectId: project.id, worker: project.worker, enabled, sync, deployments, versions: readVersions(sql, project.id, project.worker) };
      return Response.json(history);
    }
    if (!UUID.test(match[2])) return failure(400, "invalid deployment id");
    const windows = url.searchParams.getAll("window");
    if (windows.length > 1 || [...url.searchParams.keys()].some(key => key !== "window")) return failure(400, "invalid comparison window");
    const window = windows[0] ?? "1h";
    if (window !== "1h" && window !== "24h") return failure(400, "window must be 1h or 24h");
    const deployment = deployments.find(item => item.id === match[2]?.toLowerCase());
    if (deployment === undefined) return failure(404, "deployment not found");
    const bounds = comparisonBounds(deployment.atMs, window as ComparisonWindow);
    // Only additive metrics used by the comparator; never query text supplied by a user.
    const rows = sql.exec<MetricRow>(
      "SELECT metric, bucket_ms, value FROM project_samples WHERE project = ? AND bucket_ms >= ? AND bucket_ms < ? AND (metric IN ('worker.invocations', 'worker.cpuMsSum', 'worker.status.5xx', 'do.invocations', 'do.cpuMsSum', 'do.wallMsSum', 'd1.queries', 'd1.rowsRead', 'd1.rowsWritten') OR metric LIKE 'route.%.invocations' OR metric LIKE 'r2.%.ops.%' OR metric LIKE 'probe.%.up' OR metric LIKE 'probe.%.ms')",
      project.id, bounds.before.fromMs, bounds.after.toMs,
    ).toArray();
    return Response.json(compareDeployment({ deployment, deployments, rows, window, now, settleMs: PROJECT_SETTLE_MS, lastSuccessAtMs: sync?.lastSuccessAtMs ?? null, truncated: sync?.truncated ?? false, enabled, metricsSettled: hasSettledWindow(sql, project.id, project.worker, bounds.before.fromMs, bounds.before.toMs) && hasSettledWindow(sql, project.id, project.worker, bounds.after.fromMs, bounds.after.toMs), hasD1: project.d1Databases.length > 0, hasDurableObjects: project.durableObjectNamespaces.length > 0, buckets: project.buckets, probes: project.probes.map(probe => probe.name) }));
    } catch {
      console.error(JSON.stringify({ event: "deployment_api_failed" }));
      return Response.json({ error: { code: "internal", message: "deployment history unavailable" } }, { status: 500 });
    }
  }
}
