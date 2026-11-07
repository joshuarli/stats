import { verifyAccess } from "./access.ts";
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

export { Installation };

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
  async fetch(request: Request, env: Env): Promise<Response> {
    markInvocation();
    return handleStatsRequest(request, {
      authorize: candidate => verifyAccess(candidate, env),
      authorizeIngest: async (service, token) => {
        const response = await env.INSTALLATION.get(env.INSTALLATION.idFromName("installation")).fetch(new Request("https://installation/ingest/observe-auth", {
          method: "POST", headers: { "x-observe-service": service, authorization: `Bearer ${token}` }
        }));
        return response.status === 204;
      },
      serviceExists: async service => {
        const response = await env.INSTALLATION.get(env.INSTALLATION.idFromName("installation")).fetch(new Request(`https://installation/services/${encodeURIComponent(service)}`));
        return response.status === 200;
      },
      installation: internal => env.INSTALLATION.get(env.INSTALLATION.idFromName("installation")).fetch(internal),
      assets: asset => env.ASSETS.fetch(asset),
      observe: (target, init) => env.OBSERVE.fetch(target, init)
    });
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    markInvocation();
    const store = env.INSTALLATION.get(env.INSTALLATION.idFromName("installation"));
    const [metrics] = await Promise.allSettled([
      runCollector({ analytics: env.ANALYTICS_SQL, store, projectsJson: env.PROJECTS, storeWorker: env.WORKER_NAME, now: controller.scheduledTime, probeFetch: (url, init) => fetch(url, init) }),
      (async () => {
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
