import { Registry } from "../registry.ts";
import { checkIngestCommand } from "./check.ts";
import { compareCommand } from "./compare.ts";
import { costCommand } from "./cost.ts";
import { deploymentsCommand } from "./deployments.ts";
import { healthCommand } from "./health.ts";
import { observeDeploymentCommand, observeIssuesCommand, observeOperationsCommand, observeRoutesCommand, observeTracesCommand } from "./observe.ts";
import { projectsCommand } from "./projects.ts";
import { deployMarkCommand, serviceDeploymentsCommand, servicesCommand } from "./services.ts";
import { snapshotCommand } from "./snapshot.ts";
import { verifyCommand } from "./verify.ts";

export const REGISTRY = new Registry([projectsCommand, healthCommand, costCommand, snapshotCommand, deploymentsCommand, compareCommand, observeOperationsCommand, observeRoutesCommand, observeTracesCommand, observeIssuesCommand, observeDeploymentCommand, checkIngestCommand, verifyCommand, deployMarkCommand, servicesCommand, serviceDeploymentsCommand]);
