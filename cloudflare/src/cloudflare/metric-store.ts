import { DurableObject } from "cloudflare:workers";
import { CloudflareSql } from "./sql.ts";
import { handleMetricRequest } from "../metrics/http.ts";
import { MetricStoreCore } from "../metrics/store-core.ts";

export class MetricStore extends DurableObject<Env> {
  private readonly store: MetricStoreCore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new MetricStoreCore(new CloudflareSql(ctx.storage));
  }

  override fetch(request: Request): Promise<Response> {
    return handleMetricRequest(request, this.store);
  }
}
