import { DurableObject } from "cloudflare:workers";
import { cloudflareOperations } from "./operations.ts";
import { applicationEventOperations } from "../observe/application/sink.ts";
import { cloudflareClock, cloudflareScheduler } from "./ports.ts";
import { cloudflareSqlScopes } from "./sql.ts";
import { InstallationCore, type AdminResult, type HostSummary, type LatestSample } from "../core/installation/installation.ts";
import { deploymentsEnabled } from "./deployments/collector.ts";
import type { DeploymentPoll } from "../deployments/model.ts";
import { APPLICATION_EVENT_READ_LIMIT } from "../deployments/service-compare.ts";
import type { ExternalEventRecord } from "../observe/ingest/model.ts";
import type { OperationRun } from "../operations.ts";
import type { CollectorRun } from "../projects/store.ts";
import type { SystemInfo } from "../protocol.ts";

export class Installation extends DurableObject<Env> {
  private readonly core: InstallationCore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const clock = cloudflareClock(() => this.env);
    const observe = "OBSERVE" in this.env ? this.env.OBSERVE : undefined;
    const evaluationRelease = this.env.APPLICATION_EVENTS_RELEASE;
    const operations = evaluationRelease !== undefined && observe !== undefined
      ? applicationEventOperations({
          post: async body => {
            const response = await observe.fetch(new Request("https://observe/stats/ingest/observe/v1/batches", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
            return response.ok;
          },
          service: "stats",
          release: evaluationRelease,
          now: () => Date.now(),
          waitUntil: promise => { this.ctx.waitUntil(promise); }
        })
      : cloudflareOperations;
    this.core = new InstallationCore(
      {
        sql: cloudflareSqlScopes(ctx.storage), clock, scheduler: cloudflareScheduler(ctx.storage, clock), operations, probesServices: false,
        ...(observe === undefined ? {} : {
          readApplicationEvents: async (service: string, fromMs: number, toMs: number) => {
            const url = new URL(`https://observe/${encodeURIComponent(service)}/external`);
            url.searchParams.set("from", String(fromMs));
            url.searchParams.set("to", String(toMs));
            url.searchParams.set("limit", String(APPLICATION_EVENT_READ_LIMIT));
            const response = await observe.fetch(new Request(url));
            if (!response.ok) throw new Error(`observe external read failed (${response.status})`);
            const body = await response.json() as { readonly events?: unknown };
            if (!Array.isArray(body.events)) throw new Error("observe external read returned no events array");
            return { events: body.events as readonly ExternalEventRecord[], truncated: body.events.length >= APPLICATION_EVENT_READ_LIMIT };
          }
        })
      },
      { projects: () => this.env.PROJECTS, deploymentsEnabled: () => deploymentsEnabled(this.env) }
    );
    void ctx.blockConcurrencyWhile(async () => {
      this.core.initialize();
    });
  }

  createHost(name: string): Promise<AdminResult<{ hostId: string; name: string; token: string }>> {
    return this.core.createHost(name);
  }

  rotateHost(hostId: string): Promise<AdminResult<{ hostId: string; token: string }>> {
    return this.core.rotateHost(hostId);
  }

  revokeHost(hostId: string): Promise<boolean> {
    return this.core.revokeHost(hostId);
  }

  purgeHost(hostId: string): Promise<AdminResult<null>> {
    return this.core.purgeHost(hostId);
  }

  listHosts(): Promise<HostSummary[]> {
    return this.core.listHosts();
  }

  latest(hostId: string): Promise<LatestSample | null> {
    return this.core.latest(hostId);
  }

  system(hostId: string): Promise<{ hostId: string; reportedAtMs: number; system: SystemInfo } | null> {
    return this.core.system(hostId);
  }

  recordCollectorRun(run: CollectorRun): Promise<{ metricRowsWritten: number }> {
    return this.core.recordCollectorRun(run);
  }

  knownDeploymentVersions(project: string, worker: string): Promise<readonly string[]> {
    return this.core.knownDeploymentVersions(project, worker);
  }

  recordDeploymentPoll(poll: DeploymentPoll): Promise<void> {
    return this.core.recordDeploymentPoll(poll);
  }

  ingest(request: Request, operation: OperationRun): Promise<Response> {
    return this.core.ingest(request, operation);
  }

  override fetch(request: Request): Promise<Response> {
    return this.core.fetch(request);
  }

  override alarm(): Promise<void> {
    return this.core.alarm();
  }
}
