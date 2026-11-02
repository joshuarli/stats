import { describe, expect, it } from "vitest";
import { SCHEMAS, type HostKind } from "../src/binary/history";
import { encodeHostBundle, encodeHostHistory, encodeProjectBundle, encodeProjectHistory, hostHistoryColumns, roundValue, type HostHistory } from "../src/history-frame";
import type { ProjectHistory } from "../src/projects/history";
import { compact, encodeHistory, readHistory } from "./support/history";

const captured = import.meta.glob("./ui/captures/**/*.json", { eager: true, import: "default" });

function histories(): { name: string; value: Record<string, unknown> }[] {
  return Object.entries(captured).flatMap(([name, value]) => (typeof value === "object" && value !== null && "kind" in value && ("hostId" in value || "projectId" in value) ? [{ name, value: value as Record<string, unknown> }] : []));
}

function hostColumns(value: Record<string, unknown>) {
  return hostHistoryColumns(value as unknown as HostHistory);
}

describe("history frames", () => {
  it("reproduce every captured history field for field, as the independent encoder does", () => {
    const found = histories();
    expect(found.length).toBeGreaterThan(20);
    for (const { name, value } of found) {
      const frame = "hostId" in value ? encodeHostHistory(hostColumns(value)) : encodeProjectHistory(value as unknown as ProjectHistory);
      expect(readHistory(frame), name).toEqual(value);
      expect(readHistory(frame), name).toEqual(readHistory(encodeHistory(value)));
    }
  });

  it("reproduce a captured host bundle with axes shared between kinds", () => {
    const byKind = Object.fromEntries(histories().filter(({ name, value }) => name.includes("threadripper") && name.endsWith("-1h.json") && "hostId" in value).map(({ value }) => [value.kind as string, value]));
    expect(Object.keys(byKind).sort()).toEqual(["block", "disks", "filesystems", "nets", "summary"]);
    const hostId = (byKind.summary as { hostId: string }).hostId;
    const frame = encodeHostBundle(hostId, ["summary", "disks", "nets", "filesystems", "block"].map(kind => hostColumns(byKind[kind]!)));
    expect(readHistory(frame)).toEqual({ hostId, histories: byKind });
    expect(readHistory(frame)).toEqual(readHistory(encodeHistory({ hostId, histories: byKind })));
  });

  it("reproduce a captured project bundle, collector text included", () => {
    const project = Object.fromEntries(histories().filter(({ name, value }) => name.includes("/stuff/") && "projectId" in value).map(({ value }) => [value.kind as string, value]));
    expect(Object.keys(project)).toContain("collector");
    const frame = encodeProjectBundle("stuff", Object.values(project) as unknown as ProjectHistory[]);
    expect(readHistory(frame)).toEqual({ projectId: "stuff", histories: project });
  });

  it("carry every schema field, leaving cells a point lacks absent rather than zero", () => {
    function fill(kind: HostKind, row: number): Record<string, unknown> {
      const point: Record<string, unknown> = {};
      for (const [path, type] of Object.entries(SCHEMAS[kind] as Record<string, string>)) {
        const parts = path.split(".");
        let target = point;
        for (const key of parts.slice(0, -1)) target = target[key] as Record<string, unknown>;
        const leaf = parts.at(-1)!;
        target[leaf] = type === "object" ? {} : type === "boolean" ? row === 0 : path === "atMs" ? 1_000 + row * 15_000 : row + 0.1234567 + path.length;
      }
      return point;
    }
    const base = { hostId: "h_0123456789abcdef0123456789abcdef", range: "1h", fromMs: 0, toMs: 60_000, resolution: "1m", stepMs: 60_000 };
    const summary = { ...base, kind: "summary", points: [fill("summary", 0), fill("summary", 1), { atMs: 61_000, coverageMs: 5, partial: true }] };
    const devices = (kind: Exclude<HostKind, "summary">) => ({ ...base, kind, series: [{ id: "a", name: "A", points: [fill(kind, 0), fill(kind, 1)] }, { id: "b", points: [] }] });
    for (const history of [summary, devices("disks"), devices("nets"), devices("filesystems"), devices("block")]) {
      const frame = encodeHostHistory(hostColumns(history));
      expect(readHistory(frame), history.kind).toEqual(compact(history));
    }
    const read = readHistory(encodeHostHistory(hostColumns(summary))) as { points: { cpu?: unknown }[] };
    expect(read.points[2]!.cpu).toBeUndefined();
  });

  it("round to three decimals like the JSON representation did and keep integers exact", () => {
    expect(roundValue(4.733333333333333)).toBe(4.733);
    expect(roundValue(99.9996)).toBe(100);
    expect(roundValue(1_793_513_270_426)).toBe(1_793_513_270_426);
    expect(roundValue(0.0004)).toBe(0);
  });

  it("keep a project series that is entirely missing as a column of gaps", () => {
    const history: ProjectHistory = { projectId: "stuff", range: "1h", kind: "worker", fromMs: 0, toMs: 600_000, stepMs: 300_000, series: [{ metric: "worker.invocations", values: [1, null, 0] }, { metric: "worker.cpuMsSum", values: [null, null, null] }] };
    expect(readHistory(encodeProjectHistory(history))).toEqual(history);
  });
});
