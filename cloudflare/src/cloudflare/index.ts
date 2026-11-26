import { constantTimeEqual, tokenHash } from "../auth.ts";
import { INFRA_SERVICE } from "../../../packages/infra-collector/src/contract.ts";
import { PLATFORM_SERVICE } from "../../../packages/platform-bridge/src/contract.ts";
import { gatewayDecision } from "./gateway.ts";
import { Installation } from "./installation.ts";
import { collectDeployments } from "./deployments/collector.ts";
import { parseProjects } from "../projects/config.ts";
import { runCollector } from "./projects/collector.ts";
import { markInvocation } from "../observe/cloudflare/mark.ts";
import { reportError } from "../observe/producer/report.ts";
import { isObservedService } from "../observe/services.ts";
import { rolloutsFromDeployments } from "../observe/cloudflare/rollouts.ts";
import { decodeDeploymentHistory } from "../deployments/decode.ts";
import { handleStatsRequest } from "../core/http.ts";
import { createStatsHealth } from "../core/health.ts";
import { captureApplicationRequest } from "../observe/application/http.ts";
import { bufferedApplicationPost } from "../observe/application/buffered.ts";
import { postApplicationEvent } from "../observe/application/sink.ts";
import type { BrowserJourney } from "../observe/application/journey.ts";
import type { RuntimeCapabilities } from "../core/capabilities.ts";

export { Installation };
export { MetricStore } from "./metric-store.ts";

const healthChecks = new WeakMap<Env, () => Promise<Response>>();

function capabilities(env: Env): RuntimeCapabilities {
  return {
    projectSource: env.PROJECT_SOURCE,
    analyticsCollection: env.ANALYTICS_SQL !== undefined,
    cloudflareDeployments: /^[a-f0-9]{32}$/i.test(env.DEPLOYMENTS_ACCOUNT_ID ?? "") && Boolean(env.DEPLOYMENTS_API_TOKEN) && !/[\r\n]/u.test(env.DEPLOYMENTS_API_TOKEN ?? ""),
    tailEvents: env.ANALYTICS_SQL !== undefined,
    applicationEvents: true,
    infraMetrics: /^[a-f0-9]{64}$/u.test(env.INFRA_METRICS_TOKEN_SHA256 ?? "")
  };
}

async function forwardProjectRollouts(env: Env, store: DurableObjectStub<Installation>, project: string, service: string): Promise<void> {
  try {
    const response = await store.fetch(`https://installation/projects/${project}/deployments`);
    if (!response.ok) throw new Error(`deployment history unavailable (${response.status})`);
    const history = decodeDeploymentHistory(await response.json(), project);
    if (!history.enabled || history.deployments.length === 0) return;
    const sent = await env.OBSERVE.fetch(`https://observe/${service}/rollouts`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(rolloutsFromDeployments(history)) });
    if (!sent.ok) throw new Error(`rollout forward rejected (${sent.status})`);
  } catch (error) {
    reportError("deployments.forward", error);
  }
}

async function forwardRollouts(env: Env, store: DurableObjectStub<Installation>): Promise<void> {
  const observed = parseProjects(env.PROJECTS).filter(project => isObservedService(project.worker));
  await Promise.all(observed.map(project => forwardProjectRollouts(env, store, project.id, project.worker)));
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    markInvocation();
    const release = env.APPLICATION_EVENTS_RELEASE;
    let health = healthChecks.get(env);
    if (health === undefined) {
      health = createStatsHealth({
        installation: request => env.INSTALLATION.get(env.INSTALLATION.idFromName("installation")).fetch(request),
        metrics: request => env.METRICS.get(env.METRICS.idFromName(INFRA_SERVICE)).fetch(request),
        metricsAvailable: /^[a-f0-9]{64}$/u.test(env.INFRA_METRICS_TOKEN_SHA256 ?? ""), release
      });
      healthChecks.set(env, health);
    }
    const events = release === undefined ? null : {
      release, now: () => Date.now(), monotonic: () => performance.now(), waitUntil: (promise: Promise<unknown>) => { ctx.waitUntil(promise); },
      post: bufferedApplicationPost(env.OBSERVE, release)
    };
    const run = () => handleStatsRequest(request, {
      health,
      capabilities: capabilities(env),
      authorize: candidate => Promise.resolve(gatewayDecision(candidate.headers, env.GATEWAY_SECRET)),
      authorizeIngest: async (service, token) => {
        if (service === INFRA_SERVICE) {
          const verifier = env.INFRA_METRICS_TOKEN_SHA256;
          return verifier !== undefined && /^[a-f0-9]{64}$/u.test(verifier) && constantTimeEqual(await tokenHash(token), verifier);
        }
        if (service === PLATFORM_SERVICE) {
          const verifier = env.PLATFORM_BRIDGE_TOKEN_SHA256;
          return verifier !== undefined && /^[a-f0-9]{64}$/u.test(verifier) && constantTimeEqual(await tokenHash(token), verifier);
        }
        const response = await env.INSTALLATION.get(env.INSTALLATION.idFromName("installation")).fetch(new Request("https://installation/ingest/observe-auth", {
          method: "POST", headers: { "x-observe-service": service, authorization: `Bearer ${token}` }
        }));
        return response.status === 204;
      },
      serviceExists: async service => {
        if (service === PLATFORM_SERVICE) return /^[a-f0-9]{64}$/u.test(env.PLATFORM_BRIDGE_TOKEN_SHA256 ?? "");
        const response = await env.INSTALLATION.get(env.INSTALLATION.idFromName("installation")).fetch(new Request(`https://installation/services/${encodeURIComponent(service)}`));
        return response.status === 200;
      },
      metricsAvailable: /^[a-f0-9]{64}$/u.test(env.INFRA_METRICS_TOKEN_SHA256 ?? ""),
      metrics: internal => env.METRICS.get(env.METRICS.idFromName(INFRA_SERVICE)).fetch(internal),
      installation: internal => env.INSTALLATION.get(env.INSTALLATION.idFromName("installation")).fetch(internal),
      assets: asset => env.ASSETS.fetch(asset),
      observe: (target, init) => env.OBSERVE.fetch(target, init),
      ...(events === null ? {} : { recordBrowserJourney: (journey: BrowserJourney) => {
        postApplicationEvent({ schemaVersion: 1, eventId: crypto.randomUUID(), atMs: journey.startedAtMs,
          operation: `ui.${journey.source}.${journey.range}.${journey.cache ? "cache" : "read"}`, outcome: journey.outcome,
          durationMs: Math.round(journey.durationMs), trace: journey.trace, instance: `browser:${journey.asset}`,
          work: { ...journey.work, transport_dropped: journey.dropped }, service: "stats", release: events.release
        }, events);
      } })
    });
    return events === null ? run() : captureApplicationRequest(request, run, events);
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    markInvocation();
    const store = env.INSTALLATION.get(env.INSTALLATION.idFromName("installation"));
    const [metrics] = await Promise.allSettled([
      env.ANALYTICS_SQL === undefined || Math.floor(controller.scheduledTime / 60_000) % 5 !== 0
        ? Promise.resolve(null)
        : runCollector({ analytics: env.ANALYTICS_SQL, store, projectsJson: env.PROJECTS, storeWorker: env.WORKER_NAME, now: controller.scheduledTime, probeFetch: (url, init) => fetch(url, init) }),
      env.PROJECT_SOURCE === "services" ? store.collectServiceProbes().catch((error: unknown) => { reportError("services.probes", error); }) : Promise.resolve(),
      (async () => {
        if (Math.floor(controller.scheduledTime / 60_000) % 5 !== 0 || !capabilities(env).cloudflareDeployments) return;
        try {
          await collectDeployments({
            projects: parseProjects(env.PROJECTS),
            ...(env.DEPLOYMENTS_ACCOUNT_ID === undefined ? {} : { account: env.DEPLOYMENTS_ACCOUNT_ID }),
            ...(env.DEPLOYMENTS_API_TOKEN === undefined ? {} : { token: env.DEPLOYMENTS_API_TOKEN }),
            now: controller.scheduledTime, store, fetch: (url, init) => fetch(url, init)
          });
        } catch (error) {
          reportError("deployments.collect", error);
          console.error(JSON.stringify({ event: "deployment_collection_failed" }));
        }
        await forwardRollouts(env, store);
      })()
    ]);
    if (metrics.status === "rejected") throw metrics.reason;
  }
} satisfies ExportedHandler<Env>;
