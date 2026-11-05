import { Registry } from "../registry.ts";
import { compareCommand } from "./compare.ts";
import { deploymentsCommand } from "./deployments.ts";
import { healthCommand } from "./health.ts";
import { observeDeploymentCommand, observeIssuesCommand, observeRoutesCommand, observeTracesCommand } from "./observe.ts";
import { plannedCommands } from "./planned.ts";
import { projectsCommand } from "./projects.ts";

export const REGISTRY = new Registry([projectsCommand, healthCommand, deploymentsCommand, compareCommand, observeRoutesCommand, observeTracesCommand, observeIssuesCommand, observeDeploymentCommand, ...plannedCommands]);
