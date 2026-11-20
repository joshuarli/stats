declare namespace Cloudflare {
  interface Env {
    readonly INSTALLATION: DurableObjectNamespace<import("./src/cloudflare/installation").Installation>;
    readonly METRICS: DurableObjectNamespace<import("./src/cloudflare/metric-store").MetricStore>;
    readonly INFRA_METRICS_TOKEN_SHA256?: string;
    readonly ASSETS: Fetcher;
    readonly ENVIRONMENT: string;
    readonly ANALYTICS_SQL?: AnalyticsSQLBinding;
    readonly PROJECTS: string;
    readonly PROJECT_SOURCE: "cloudflare" | "services";
    readonly WORKER_NAME: string;
    readonly OBSERVE: Fetcher;
    readonly TEST_NOW_MS?: string;
    readonly GATEWAY_SECRET?: string;
    readonly PLATFORM_BRIDGE_TOKEN_SHA256?: string;
    readonly APPLICATION_EVENTS_RELEASE?: string;
    readonly FIXTURES?: string;
    readonly DEPLOYMENTS_ACCOUNT_ID?: string;
    readonly DEPLOYMENTS_API_TOKEN?: string;
  }
}

interface Env extends Cloudflare.Env {}
