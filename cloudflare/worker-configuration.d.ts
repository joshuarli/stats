declare namespace Cloudflare {
  interface Env {
    readonly INSTALLATION: DurableObjectNamespace<import("./src/cloudflare/installation").Installation>;
    readonly ASSETS: Fetcher;
    readonly ENVIRONMENT: string;
    readonly ANALYTICS_SQL: AnalyticsSQLBinding;
    readonly PROJECTS: string;
    readonly WORKER_NAME: string;
    readonly OBSERVE: Fetcher;
    readonly TEST_NOW_MS?: string;
    readonly GATEWAY_SECRET?: string;
    readonly APPLICATION_EVENTS_RELEASE?: string;
    readonly FIXTURES?: string;
    readonly DEPLOYMENTS_ACCOUNT_ID?: string;
    readonly DEPLOYMENTS_API_TOKEN?: string;
  }
}

interface Env extends Cloudflare.Env {}
