import { decodeObjectMethods } from "../observe/client/decode.ts";
import { RETENTION_MS } from "../observe/core/limits.ts";
import { isObservedService } from "../observe/services.ts";
import type { MetricHistory } from "../client/history.ts";
import { decodeWorkerHistory } from "../client/history.ts";
import { openHistory } from "../binary/history.ts";
import type { ProjectSummary } from "../client/project-model.ts";
import { assembleProjectLedger, baselineMethodsRetained, decodeProjectFrame, historyKinds, ledgerHistories, objectMethodsOf, observeObjectsPath, projectHistoryPath, type ProjectLedger } from "../client/project-ledger.ts";
import type { Warning } from "./envelope.ts";
import { CommandError, EXIT, transportError } from "./exit.ts";
import type { CommandContext } from "./registry.ts";
import type { CostInputs, ObservedMethods } from "./snapshot-format.ts";
import { probeRange, resolveWindows, type ResolvedWindows, type WindowRequest } from "./windows.ts";

async function fetchBytes(context: CommandContext, path: string): Promise<Uint8Array> {
  const fetched = await context.http.getBytes(path);
  if (fetched.kind !== "ok") throw transportError("contract", `${path} answered not-modified to an unconditional request`);
  return fetched.value;
}

function malformedFrame(path: string, error: unknown): CommandError {
  return transportError("malformed_frame", `${path} did not return a valid history frame: ${error instanceof Error ? error.message : "invalid"}`);
}

export async function settleProbe(context: CommandContext, projectId: string, request: WindowRequest): Promise<MetricHistory | null> {
  const range = probeRange(request);
  if (range === null) return null;
  const path = `/api/v1/projects/${encodeURIComponent(projectId)}/history?range=${range}&kinds=worker`;
  const bytes = await fetchBytes(context, path);
  try {
    return decodeWorkerHistory(openHistory(bytes).root);
  } catch (error) {
    throw malformedFrame(path, error);
  }
}

async function optional<T>(read: () => Promise<T>, failure: (error: CommandError) => Warning): Promise<{ readonly value: T | null; readonly note: Warning | null }> {
  try {
    return { value: await read(), note: null };
  } catch (error) {
    if (error instanceof CommandError && error.exit !== EXIT.auth) return { value: null, note: failure(error) };
    throw error;
  }
}

function validated(path: string, bytes: Uint8Array): Uint8Array {
  try {
    decodeProjectFrame(bytes);
    return bytes;
  } catch (error) {
    throw malformedFrame(path, error);
  }
}

export async function loadCostInputs(context: CommandContext, project: ProjectSummary, windows: ResolvedWindows, capturedAtMs: number, sharedRequests: number): Promise<CostInputs> {
  const before = context.http.requests();
  const kinds = historyKinds(project);
  const currentPath = projectHistoryPath(project.id, windows.current, kinds);
  const previousPath = projectHistoryPath(project.id, windows.previous, kinds);
  const observed = isObservedService(project.worker) && kinds.durableObjects;
  const [current, previous, methods] = await Promise.all([
    fetchBytes(context, currentPath).then(bytes => validated(currentPath, bytes)),
    optional(() => fetchBytes(context, previousPath).then(bytes => validated(previousPath, bytes)), error => ({ code: "baseline_unavailable", message: `the previous window could not be read: ${error.message}` })),
    observed ? optional(() => loadMethods(context, project.worker, windows, capturedAtMs), error => ({ code: "object_methods_unavailable", message: `Durable Object method statistics could not be read: ${error.message}` })) : Promise.resolve(null)
  ]);
  const notes = [previous.note, methods?.note ?? null].filter((note): note is Warning => note !== null);
  return {
    capturedAtMs,
    project,
    windows,
    notes,
    requests: { shared: sharedRequests, project: context.http.requests() - before },
    current,
    previous: previous.value,
    methods: methods?.value ?? null
  };
}

async function loadMethods(context: CommandContext, service: string, windows: ResolvedWindows, capturedAtMs: number): Promise<ObservedMethods> {
  const base = `/api/observe/${encodeURIComponent(service)}`;
  const read = async (path: string) => {
    const fetched = await context.http.getJson(`${base}${path}`, decodeObjectMethods);
    if (fetched.kind !== "ok") throw transportError("contract", `${base}${path} answered not-modified to an unconditional request`);
    return fetched.value;
  };
  const [now, before] = await Promise.all([
    read(observeObjectsPath(windows.current)),
    baselineMethodsRetained(windows.previous, capturedAtMs, RETENTION_MS) ? read(observeObjectsPath(windows.previous)) : Promise.resolve(null)
  ]);
  return { now, before };
}

export async function resolveLive(context: CommandContext, probeProject: string, request: WindowRequest): Promise<ResolvedWindows> {
  return resolveWindows(request, await settleProbe(context, probeProject, request));
}

export function ledgerOf(inputs: CostInputs): ProjectLedger {
  const current = decodeProjectFrame(inputs.current);
  return assembleProjectLedger({
    nowMs: inputs.capturedAtMs,
    project: inputs.project,
    windows: { current: inputs.windows.current, previous: inputs.windows.previous },
    current,
    baseline: inputs.previous === null ? undefined : decodeProjectFrame(inputs.previous),
    objectMethods: inputs.methods === null ? undefined : objectMethodsOf(inputs.methods.now, inputs.methods.before),
    planMonth: inputs.windows.monthToDate ? { histories: ledgerHistories(current), settledMs: inputs.windows.current.toMs } : undefined
  });
}
