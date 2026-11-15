import { constantTimeEqual, tokenHash } from "../auth.ts";
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
import { captureApplicationRequest } from "../observe/application/http.ts";
import { bufferedApplicationPost } from "../observe/application/buffered.ts";
import type { RuntimeCapabilities } from "../core/capabilities.ts";

export { Installation };

function capabilities(env: Env): RuntimeCapabilities {
  return { projectSource: env.PROJECT_SOURCE, analyticsCollection: env.ANALYTICS_SQL !== undefined, cloudflareDeployments: /^[a-f0-9]{32}$/i.test(env.DEPLOYMENTS_ACCOUNT_ID ?? "") && Boolean(env.DEPLOYMENTS_API_TOKEN) && !/[\r\n]/u.test(env.DEPLOYMENTS_API_TOKEN ?? ""), tailEvents: env.ANALYTICS_SQL !== undefined, applicationEvents: true };
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
    const run = () => handleStatsRequest(request, {
      capabilities: capabilities(env),
      authorize: candidate => Promise.resolve(gatewayDecision(candidate.headers, env.GATEWAY_SECRET)),
      authorizeIngest: async (service, token) => {
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
      installation: internal => env.INSTALLATION.get(env.INSTALLATION.idFromName("installation")).fetch(internal),
      assets: asset => env.ASSETS.fetch(asset),
      observe: (target, init) => env.OBSERVE.fetch(target, init)
    });
    if (env.APPLICATION_EVENTS_RELEASE === undefined) return run();
    return captureApplicationRequest(request, run, {
      release: env.APPLICATION_EVENTS_RELEASE, now: () => Date.now(), monotonic: () => performance.now(), waitUntil: promise => { ctx.waitUntil(promise); },
      post: bufferedApplicationPost(env.OBSERVE, env.APPLICATION_EVENTS_RELEASE)
    });
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    markInvocation();
    const store = env.INSTALLATION.get(env.INSTALLATION.idFromName("installation"));
    const [metrics] = await Promise.allSettled([
      env.ANALYTICS_SQL === undefined
        ? Promise.resolve(null)
        : runCollector({ analytics: env.ANALYTICS_SQL, store, projectsJson: env.PROJECTS, storeWorker: env.WORKER_NAME, now: controller.scheduledTime, probeFetch: (url, init) => fetch(url, init) }),
      (async () => {
        if (!capabilities(env).cloudflareDeployments) return;
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
