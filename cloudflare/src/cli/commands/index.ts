import { Registry } from "../registry.ts";
import { costCommand } from "./cost.ts";
import { healthCommand } from "./health.ts";
import { plannedCommands } from "./planned.ts";
import { projectsCommand } from "./projects.ts";
import { snapshotCommand } from "./snapshot.ts";

export const REGISTRY = new Registry([projectsCommand, healthCommand, costCommand, snapshotCommand, ...plannedCommands]);
