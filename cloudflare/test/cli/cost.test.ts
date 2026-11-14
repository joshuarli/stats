import assert from "node:assert/strict";
import { test } from "node:test";
import { EXIT } from "../../src/cli/exit.ts";
import { PRICING_REVISION } from "../../src/cost/pricing.ts";
import { documentOf, NOW_MS, payloadOf, PLAIN, serve, STATS, statsctl } from "./cost-support.ts";

const STEP = 300_000;
const HOUR = 3_600_000;
const SETTLED_MS = (Math.floor((NOW_MS - STEP - 45 * 60_000) / STEP) + 1) * STEP;

await test("the default window is the latest settled hour, not the newest incomplete one", async () => {
  const origin = await serve({ projects: [STATS] });
  try {
    const ran = await statsctl(["cost", "--project", "stats", "--json"], { origin: origin.origin });
    assert.equal(ran.code, EXIT.ok, ran.stderr);
    const document = documentOf(ran);
    const report = payloadOf(ran).projects[0]!.report!;
    assert.deepEqual(report.windows.current, { fromMs: SETTLED_MS - HOUR, toMs: SETTLED_MS });
    assert.deepEqual(report.windows.previous, { fromMs: SETTLED_MS - 2 * HOUR, toMs: SETTLED_MS - HOUR });
    assert.ok(SETTLED_MS <= NOW_MS - 45 * 60_000);
    assert.deepEqual(document["windows"], [report.windows.current, report.windows.previous]);
    assert.equal(document["pricingRevision"], PRICING_REVISION);
    assert.equal(document["project"], "stats");
    assert.ok((document["priced"] as string[]).includes("stats:workerRequests"));
    assert.ok(typeof (document["coverage"] as Record<string, string>)["stats"] === "string");
    assert.equal((document["units"] as Record<string, string>)["currency"], "USD");
    assert.equal(origin.seen[1]?.url, "/api/v1/projects/stats/history?range=1h&kinds=worker");
    assert.ok(origin.seen.every(request => request.headers["cf-access-token"] === undefined));
  } finally {
    await origin.close();
  }
});

await test("a project makes at most four requests after the shared project list and settle probe", async () => {
  const origin = await serve({ projects: [STATS, PLAIN] });
  try {
    const one = await statsctl(["cost", "--project", "stats", "--json"], { origin: origin.origin });
    const payload = payloadOf(one);
    assert.equal(payload.requests.shared, 2);
    assert.equal(payload.projects[0]!.requests, 4);
    assert.equal(payload.requests.total, origin.seen.length);
    const before = origin.seen.length;
    const all = await statsctl(["cost", "--all", "--window", "24h", "--json"], { origin: origin.origin });
    const everything = payloadOf(all);
    assert.deepEqual(everything.projects.map(project => [project.id, project.requests]), [["plain", 2], ["stats", 4]]);
    assert.ok(everything.projects.every(project => project.requests <= 4));
    assert.equal(everything.requests.total, origin.seen.length - before);
    assert.equal(origin.seen.filter(request => request.url?.includes("kinds=worker") === true && request.url.includes("range=")).length, 2);
  } finally {
    await origin.close();
  }
});

await test("sampled object methods report their coverage and keep a sampled-out baseline unknown", async () => {
  const origin = await serve({
    projects: [STATS],
    objectMethods: url => ({
      fromMs: Number(url.searchParams.get("from")),
      toMs: Number(url.searchParams.get("to")),
      methods: Number(url.searchParams.get("to")) === SETTLED_MS ? [{ label: "Installation.jsrpc", requests: 4, failed: 0, cpuMs: 10, wallMs: 20, p50WallMs: 5, p95WallMs: 8 }] : [],
      sampling: { keepPerMillion: 100_000, kept: 4, observed: 40 }
    })
  });
  try {
    const ran = await statsctl(["cost", "--project", "stats", "--json"], { origin: origin.origin });
    assert.equal(ran.code, EXIT.ok, ran.stderr);
    const report = payloadOf(ran).projects[0]!.report!;
    const objects = report.lines.find(line => line.id === "objects")!;
    const method = objects.children.find(line => line.id === "object:Installation.jsrpc")!;
    assert.equal(method.price.kind, "priced");
    if (method.price.kind !== "priced") throw new Error("expected a priced method");
    assert.equal(method.price.monthly.before, null);
    assert.equal(method.price.bound, "estimate");
    assert.deepEqual(report.warnings.filter(warning => warning.code === "object-method-sampled").map(warning => warning.subject), ["current", "previous"]);
  } finally {
    await origin.close();
  }
});

await test("missing Worker CPU is excluded from the CLI total and monthly bill", async () => {
  const origin = await serve({ projects: [{ ...STATS, missingWorkerCpu: true }] });
  try {
    const ran = await statsctl(["cost", "--project", "stats", "--month-to-date", "--json"], { origin: origin.origin });
    assert.equal(ran.code, EXIT.ok, ran.stderr);
    const report = payloadOf(ran).projects[0]!.report!;
    const worker = report.lines.find(line => line.id === "worker")!;
    assert.equal(worker.usage.kind === "requests" && worker.usage.cpuMs, null);
    assert.ok(!report.total.pricedMeters.includes("workerCpuMs"));
    assert.ok(report.total.excluded.some(entry => entry.meter === "workerCpuMs" && entry.reason === "no-data"));
    assert.equal(report.planBill.kind, "isolated");
    assert.equal(report.planBill.usage?.workerCpuMs, null);
    assert.ok(report.planBill.missingBilledMeters?.includes("workerCpuMs"));
    assert.ok(report.planBill.missingProjectionMeters?.includes("workerCpuMs"));
    assert.deepEqual(report.planBill.durationProxy, { billed: true, projected: true });
    assert.ok(report.warnings.some(warning => warning.code === "plan-duration-upper-bound-proxy"));
  } finally {
    await origin.close();
  }
});

await test("missing D1 rows are excluded from the CLI total and monthly bill", async () => {
  const origin = await serve({ projects: [{ ...STATS, missingD1Written: true }] });
  try {
    const ran = await statsctl(["cost", "--project", "stats", "--month-to-date", "--json"], { origin: origin.origin });
    assert.equal(ran.code, EXIT.ok, ran.stderr);
    const report = payloadOf(ran).projects[0]!.report!;
    const d1 = report.lines.find(line => line.id === "d1")!;
    assert.equal(d1.usage.kind === "rows" && d1.usage.written, null);
    assert.ok(report.total.pricedMeters.includes("d1RowsRead"));
    assert.ok(report.total.excluded.some(entry => entry.meter === "d1RowsWritten" && entry.reason === "no-data"));
    assert.equal(report.planBill.usage?.d1RowsWritten, null);
    assert.ok(report.planBill.missingBilledMeters?.includes("d1RowsWritten"));
    assert.ok(report.planBill.missingProjectionMeters?.includes("d1RowsWritten"));
  } finally {
    await origin.close();
  }
});

await test("missing D1 storage leaves nullable usage, no zero-dollar part, and a named meter", async () => {
  const origin = await serve({ projects: [{ ...STATS, missingD1Storage: true }] });
  try {
    const ran = await statsctl(["cost", "--project", "stats", "--month-to-date", "--json"], { origin: origin.origin });
    assert.equal(ran.code, EXIT.ok, ran.stderr);
    const report = payloadOf(ran).projects[0]!.report!;
    const d1 = report.lines.find(line => line.id === "d1")!;
    assert.equal(d1.confidence, "qualified");
    assert.ok(d1.parts.every(part => part.label !== "storage"));
    assert.ok(report.total.excluded.some(entry => entry.meter === "d1Storage" && entry.reason === "no-data"));
    assert.ok(report.warnings.some(warning => warning.code === "meter-no-data" && warning.subject === "d1Storage"));
    assert.equal(report.planBill.usage?.d1Storage, null);
    assert.ok(report.planBill.missingBilledMeters?.includes("d1Storage"));
    assert.ok(report.planBill.missingProjectionMeters?.includes("d1Storage"));
  } finally {
    await origin.close();
  }
});

await test("partial D1 storage names the meter instead of presenting a complete subtotal", async () => {
  const origin = await serve({ projects: [{ ...STATS, partialD1Storage: true }] });
  try {
    const ran = await statsctl(["cost", "--project", "stats", "--month-to-date", "--json"], { origin: origin.origin });
    assert.equal(ran.code, EXIT.ok, ran.stderr);
    const report = payloadOf(ran).projects[0]!.report!;
    const d1 = report.lines.find(line => line.id === "d1")!;
    assert.equal(d1.confidence, "qualified");
    assert.ok(report.total.pricedMeters.includes("d1Storage"));
    assert.ok(report.warnings.some(warning => warning.code === "meter-partial-data" && warning.subject === "d1Storage"));
    assert.ok(report.planBill.usage?.d1Storage !== null);
    assert.ok(report.planBill.partialBilledMeters?.includes("d1Storage"));
    assert.ok(report.planBill.partialProjectionMeters?.includes("d1Storage"));
    assert.equal(report.planBill.missingBilledMeters?.includes("d1Storage"), false);
  } finally {
    await origin.close();
  }
});

await test("missing Durable Object wall time is excluded from the CLI total and monthly bill", async () => {
  const origin = await serve({ projects: [{ ...STATS, missingObjectWall: true }] });
  try {
    const ran = await statsctl(["cost", "--project", "stats", "--month-to-date", "--json"], { origin: origin.origin });
    assert.equal(ran.code, EXIT.ok, ran.stderr);
    const report = payloadOf(ran).projects[0]!.report!;
    const objects = report.lines.find(line => line.id === "objects")!;
    assert.equal(objects.usage.kind === "objects" && objects.usage.wallMs, null);
    assert.ok(report.total.pricedMeters.includes("durableObjectRequests"));
    assert.ok(report.total.excluded.some(entry => entry.meter === "durableObjectGbSeconds" && entry.reason === "no-data"));
    assert.equal(report.planBill.usage?.durableObjectGbSeconds, null);
    assert.ok(report.planBill.missingBilledMeters?.includes("durableObjectGbSeconds"));
    assert.deepEqual(report.planBill.durationProxy, { billed: false, projected: false });
  } finally {
    await origin.close();
  }
});

await test("--all marks a failing project unavailable and still reports the others", async () => {
  const origin = await serve({ projects: [{ ...PLAIN, fail: url => url.searchParams.get("range") === null ? 404 : undefined }, STATS] });
  try {
    const ran = await statsctl(["cost", "--all", "--json"], { origin: origin.origin });
    assert.equal(ran.code, EXIT.ok, ran.stderr);
    const projects = payloadOf(ran).projects;
    assert.deepEqual(projects.map(project => [project.id, project.status]), [["plain", "unavailable"], ["stats", "ok"]]);
    assert.equal(projects[0]!.error?.code, "not_found");
    assert.ok((documentOf(ran)["warnings"] as { message: string }[]).some(warning => warning.message.startsWith("plain: unavailable")));
  } finally {
    await origin.close();
  }
});

await test("a failing current history fails a single-project run with a transport error", async () => {
  const origin = await serve({ projects: [{ ...STATS, fail: url => url.searchParams.get("range") === null ? 500 : undefined }] });
  try {
    const ran = await statsctl(["cost", "--project", "stats", "--json"], { origin: origin.origin });
    assert.equal(ran.code, EXIT.transport);
    assert.equal((documentOf(ran)["error"] as { code: string }).code, "http_500");
  } finally {
    await origin.close();
  }
});

await test("an unreadable previous window degrades to a warning and an absent baseline", async () => {
  const origin = await serve({ projects: [{ ...PLAIN, fail: url => Number(url.searchParams.get("to")) === SETTLED_MS - HOUR ? 404 : undefined }] });
  try {
    const ran = await statsctl(["cost", "--project", "plain", "--json"], { origin: origin.origin });
    assert.equal(ran.code, EXIT.ok, ran.stderr);
    const report = payloadOf(ran).projects[0]!.report!;
    assert.equal(report.comparison.baseline, "absent");
    assert.ok(report.warnings.some(warning => warning.code === "baseline-unavailable"));
    assert.ok((documentOf(ran)["warnings"] as { code: string }[]).some(warning => warning.code === "baseline_unavailable"));
  } finally {
    await origin.close();
  }
});

await test("--from and --to are validated before any request", async () => {
  const origin = await serve({ projects: [STATS] });
  try {
    const cases: readonly (readonly string[])[] = [
      ["--from", "5", "--to", "5"], ["--from", "9", "--to", "5"], ["--from", "abc", "--to", "9"], ["--from", "-1", "--to", "9"], ["--from", "1.5", "--to", "9"],
      ["--from", "1000", "--to", String(1000 + 31 * 24 * HOUR)], ["--from", "1000"], ["--to", "1000"], ["--window", "2h"], ["--window", "1h", "--from", "1", "--to", "2"]
    ];
    for (const extra of cases) {
      const ran = await statsctl(["cost", "--project", "stats", ...extra, "--json"], { origin: origin.origin });
      assert.equal(ran.code, EXIT.usage, extra.join(" "));
      assert.equal((documentOf(ran)["error"] as { code: string }).code, "usage");
    }
    assert.equal(origin.seen.length, 0);
  } finally {
    await origin.close();
  }
});

await test("an explicit window skips the settle probe and is half-open", async () => {
  const origin = await serve({ projects: [PLAIN] });
  try {
    const from = NOW_MS - 5 * HOUR;
    const to = NOW_MS - 3 * HOUR;
    const ran = await statsctl(["cost", "--project", "plain", "--from", String(from), "--to", String(to), "--json"], { origin: origin.origin });
    assert.equal(ran.code, EXIT.ok, ran.stderr);
    const payload = payloadOf(ran);
    assert.deepEqual(payload.projects[0]!.report!.windows, { current: { fromMs: from, toMs: to }, previous: { fromMs: from - 2 * HOUR, toMs: from } });
    assert.equal(payload.requests.shared, 1);
    assert.ok(origin.seen.every(request => !(request.url ?? "").includes("range=")));
  } finally {
    await origin.close();
  }
});

await test("selectors are exclusive, one is required, and unknown projects are usage errors", async () => {
  const origin = await serve({ projects: [STATS] });
  try {
    const cases: readonly (readonly string[])[] = [
      ["--project", "stats", "--all"], ["--all", "--input", "x.json"], ["--window", "1h", "--month-to-date"], [], ["--project", "nope"], ["--input", "x.json", "--window", "1h"], ["--input", "x.json", "--month-to-date"]
    ];
    for (const extra of cases) {
      const ran = await statsctl(["cost", ...extra, "--json"], { origin: origin.origin });
      assert.equal(ran.code, EXIT.usage, extra.join(" "));
    }
  } finally {
    await origin.close();
  }
});

await test("--month-to-date prices the UTC month so far and adds the isolated plan bill from the same history", async () => {
  const origin = await serve({ projects: [STATS] });
  try {
    const ran = await statsctl(["cost", "--project", "stats", "--month-to-date", "--json"], { origin: origin.origin });
    assert.equal(ran.code, EXIT.ok, ran.stderr);
    const payload = payloadOf(ran);
    const report = payload.projects[0]!.report!;
    assert.equal(report.windows.current.fromMs, Date.UTC(2026, 10, 1));
    assert.equal(report.windows.current.toMs, SETTLED_MS);
    assert.equal(report.planBill.kind, "isolated");
    assert.equal(report.planBill.basis, "utc-month");
    assert.equal(report.planBill.billed, undefined);
    assert.equal(payload.projects[0]!.requests, 3);
  } finally {
    await origin.close();
  }
});

await test("detail is bounded to 15 children per line and series are omitted unless asked for", async () => {
  const origin = await serve({ projects: [{ ...PLAIN, routes: 20 }] });
  try {
    const plain = await statsctl(["cost", "--project", "plain", "--json"], { origin: origin.origin });
    const worker = payloadOf(plain).projects[0]!.report!.lines.find(line => line.id === "worker")!;
    assert.equal(worker.children.length, 15);
    assert.ok(worker.children.some(child => child.kind === "unrouted"));
    assert.ok((worker.omitted?.count ?? 0) >= 6);
    assert.ok(!plain.stdout.includes('"trend"'));
    const full = await statsctl(["cost", "--project", "plain", "--series", "--json"], { origin: origin.origin });
    assert.ok(full.stdout.includes('"trend"'));
    const month = await statsctl(["cost", "--project", "plain", "--month-to-date", "--series", "--json"], { origin: origin.origin });
    assert.ok(payloadOf(month).projects[0]!.report!.planBill.billed !== undefined);
  } finally {
    await origin.close();
  }
});

await test("text mode prints a ranked table without JSON", async () => {
  const origin = await serve({ projects: [STATS] });
  try {
    const ran = await statsctl(["cost", "--project", "stats"], { origin: origin.origin });
    assert.equal(ran.code, EXIT.ok, ran.stderr);
    assert.match(ran.stdout, /^cost, pricing revision/u);
    assert.match(ran.stdout, /stats: \$[0-9.]+\/month list-price run rate/u);
    assert.ok(!ran.stdout.trimStart().startsWith("{"));
  } finally {
    await origin.close();
  }
});
