import { verifyReleaseCommand } from "./verify-release.ts";
import { Registry } from "../registry.ts";
import { backupExportCommand, backupFenceCommand, backupImportCommand, backupObjectsCommand, backupStatusCommand } from "./backup.ts";
import { checkHostsCommand, checkIngestCommand } from "./check.ts";
import { compareCommand } from "./compare.ts";
import { costCommand } from "./cost.ts";
import { deploymentsCommand } from "./deployments.ts";
import { healthCommand } from "./health.ts";
import { observeApplicationCommand, observeDeploymentCommand, observeIssuesCommand, observeOperationsCommand, observeRoutesCommand, observeTracesCommand } from "./observe.ts";
import { observeRolloutsCommand } from "./observe-rollouts.ts";
import { projectsCommand } from "./projects.ts";
import { deployMarkCommand, serviceCheckCommand, serviceCreateCommand, serviceUpdateCommand, serviceDeploymentsCommand, serviceInspectCommand, servicesCommand, serviceTokenRevokeCommand, serviceTokenRotateCommand } from "./services.ts";
import { snapshotCommand } from "./snapshot.ts";
import { verifyCommand } from "./verify.ts";

export const REGISTRY = new Registry([projectsCommand, healthCommand, costCommand, snapshotCommand, deploymentsCommand, compareCommand, observeOperationsCommand, observeApplicationCommand, observeRoutesCommand, observeTracesCommand, observeIssuesCommand, observeDeploymentCommand, observeRolloutsCommand, checkIngestCommand, checkHostsCommand, verifyCommand, verifyReleaseCommand, deployMarkCommand, servicesCommand, serviceCreateCommand, serviceUpdateCommand, serviceInspectCommand, serviceDeploymentsCommand, serviceTokenRotateCommand, serviceTokenRevokeCommand, serviceCheckCommand, backupObjectsCommand, backupStatusCommand, backupFenceCommand, backupExportCommand, backupImportCommand]);
