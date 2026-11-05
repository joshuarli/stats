import { defineCommand } from "../registry.ts";
import { decodeProjects, type ProjectSummary } from "../decode.ts";
import { table, timeText } from "../text.ts";

export interface ProjectsPayload {
  readonly projects: readonly ProjectSummary[];
}

export const projectsCommand = defineCommand<ProjectsPayload>({
  name: "projects",
  summary: "list the projects the stats origin monitors",
  description: [
    "Lists every configured project with its Worker and the freshness of its analytics collector.",
    "Start here to learn the project ids that other commands take as --project."
  ],
  access: "read",
  options: {},
  examples: ["statsctl projects", "statsctl projects --json"],
  limitations: ["Reports collector state as the server last recorded it; run `statsctl health --project <id>` to judge freshness."],
  async run(context) {
    const fetched = await context.http.getJson("/api/v1/projects", decodeProjects);
    if (fetched.kind !== "ok") throw new Error("unconditional request answered not-modified");
    return { payload: { projects: fetched.value } };
  },
  render({ projects }) {
    if (projects.length === 0) return ["no projects configured"];
    return table([["project", "worker", "collector", "last success"], ...projects.map(project => [project.id, project.worker, project.collector.stale ? "stale" : "fresh", timeText(project.collector.lastSuccessAtMs)])]);
  }
});
