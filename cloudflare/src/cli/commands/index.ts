import { Registry } from "../registry.ts";
import { healthCommand } from "./health.ts";
import { plannedCommands } from "./planned.ts";
import { projectsCommand } from "./projects.ts";

export const REGISTRY = new Registry([projectsCommand, healthCommand, ...plannedCommands]);
