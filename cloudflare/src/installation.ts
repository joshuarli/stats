import { DurableObject } from "cloudflare:workers";
import { cloudflareOperations } from "./cloudflare/operations.ts";
import { cloudflareClock, cloudflareScheduler } from "./cloudflare/ports.ts";
import { cloudflareSqlScopes } from "./cloudflare/sql.ts";
import { InstallationCore, type AdminResult, type HostSummary, type LatestSample } from "./core/installation/installation.ts";
import type { DeploymentPoll } from "./deployments/collector.ts";
import { deploymentsEnabled } from "./deployments/collector.ts";
import type { OperationRun } from "./operations.ts";
import type { CollectorRun } from "./projects/store.ts";
import type { SystemInfo } from "./protocol.ts";

export class Installation extends DurableObject<Env> {
  private readonly core: InstallationCore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.core = new InstallationCore(
      { sql: cloudflareSqlScopes(ctx.storage), clock: cloudflareClock(() => this.env), scheduler: cloudflareScheduler(ctx.storage), operations: cloudflareOperations },
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

  purgeHost(hostId: string): Promise<boolean> {
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
