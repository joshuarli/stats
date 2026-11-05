import assert from "node:assert/strict";
import { test } from "node:test";
import { EXIT } from "../../src/cli/exit.ts";
import { useColour } from "../../src/cli/text.ts";
import { authorized, deploymentHistory, fakeOrigin, observeHealth, projectEntry, runCli, sendJson, TOKEN, tokenEnv, type FakeOrigin, type Handler } from "./support.ts";

async function withOrigin(handler: Handler, body: (origin: FakeOrigin) => Promise<void>): Promise<void> {
  const origin = await fakeOrigin(handler);
  try {
    await body(origin);
  } finally {
    await origin.close();
  }
}

function document(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

function errorOf(stdout: string): { code: string; message: string } {
  return document(stdout)["error"] as { code: string; message: string };
}

const jsonRun = (origin: FakeOrigin, args: readonly string[], extra: Record<string, string> = {}) => runCli([...args, "--json", "--origin", origin.origin], tokenEnv(extra));

await test("the exit code map matches the contract", () => {
  assert.deepEqual({ ...EXIT }, { ok: 0, usage: 2, auth: 3, transport: 4, pending: 5, unchanged: 6, regressed: 7 });
});

await test("unknown options, missing selectors, and conflicting selectors exit 2", async () => {
  const cases: string[][] = [
    ["projects", "--bogus"], ["projects", "extra"], ["health"], ["health", "--project", "Bad Id"], ["nosuch"], ["observe"], ["--json"],
    ["cost", "--project", "stats", "--all"], ["cost", "--from", "1"], ["cost", "--window", "1h", "--month-to-date"], ["snapshot", "--project", "stats"],
    ["compare", "--project", "stats"], ["check", "ingest"], ["projects", "--origin", "http://example.com"], ["projects", "--origin", "not a url"]
  ];
  for (const args of cases) {
    const run = await runCli(args, tokenEnv());
    assert.equal(run.code, EXIT.usage, `${args.join(" ")}: ${run.stdout}${run.stderr}`);
    assert.notEqual(run.stderr, "", args.join(" "));
  }
});

await test("a usage error in --json mode is one failure document", async () => {
  const run = await runCli(["cost", "--project", "stats", "--all", "--json"]);
  assert.equal(run.code, EXIT.usage);
  const parsed = document(run.stdout);
  assert.equal(parsed["schema"], "statsctl/1");
  assert.equal(parsed["command"], "cost");
  assert.equal((parsed["error"] as { code: string }).code, "usage");
  assert.ok(!("payload" in parsed));
  assert.match((parsed["error"] as { message: string }).message, /--project and --all/);
});

await test("projects returns a sorted payload inside one statsctl/1 document", async () => {
  await withOrigin((request, response) => {
    if (!authorized(request)) return sendJson(response, {}, 401);
    sendJson(response, [projectEntry("stats"), projectEntry("alpha", { collector: { lastRunAtMs: null, lastSuccessAtMs: null, lastError: "boom", stale: true } })]);
  }, async origin => {
    const run = await jsonRun(origin, ["projects"]);
    assert.equal(run.code, EXIT.ok, run.stderr);
    const parsed = document(run.stdout);
    assert.equal(parsed["schema"], "statsctl/1");
    assert.equal(parsed["command"], "projects");
    assert.equal(parsed["origin"], origin.origin);
    assert.equal(typeof parsed["generatedAtMs"], "number");
    assert.deepEqual(parsed["windows"], []);
    assert.deepEqual(parsed["warnings"], []);
    const projects = (parsed["payload"] as { projects: { id: string }[] }).projects;
    assert.deepEqual(projects.map(project => project.id), ["alpha", "stats"]);
    assert.equal(origin.seen[0]?.url, "/api/v1/projects");
    assert.ok(!run.stdout.includes(TOKEN) && !run.stderr.includes(TOKEN));
  });
});

await test("text mode prints a table, no escape codes, and nothing on stdout from diagnostics", async () => {
  await withOrigin((_, response) => { sendJson(response, [projectEntry("stats")]); }, async origin => {
    for (const extra of [{}, { NO_COLOR: "1" }, { NO_COLOR: "" }]) {
      const run = await runCli(["projects", "--origin", origin.origin], tokenEnv(extra));
      assert.equal(run.code, EXIT.ok);
      assert.match(run.stdout, /^project\s+worker\s+collector/u);
      assert.match(run.stdout, /stats\s+stats-worker\s+fresh/u);
      assert.ok(!run.stdout.includes("\u001b"));
    }
  });
});

await test("colour is only for an interactive terminal without NO_COLOR", () => {
  assert.equal(useColour({}, true, false), true);
  assert.equal(useColour({ NO_COLOR: "1" }, true, false), false);
  assert.equal(useColour({}, false, false), false);
  assert.equal(useColour({}, true, true), false);
  assert.equal(useColour({ TERM: "dumb" }, true, false), false);
});

await test("an HTML login page, 401, 403, and a redirect are authentication failures", async () => {
  const replies: [string, Handler][] = [
    ["login_page", (_, response) => { response.writeHead(200, { "content-type": "text/html" }); response.end("<!doctype html><title>Sign in</title>"); }],
    ["login_page", (_, response) => { response.writeHead(200, { "content-type": "application/json" }); response.end("<html>Sign in</html>"); }],
    ["unauthorized", (_, response) => { response.writeHead(401).end(); }],
    ["unauthorized", (_, response) => { response.writeHead(403).end(); }],
    ["redirect", (_, response) => { response.writeHead(302, { location: "https://team.cloudflareaccess.com/login" }).end(); }]
  ];
  for (const [code, handler] of replies) {
    await withOrigin(handler, async origin => {
      const run = await jsonRun(origin, ["projects"]);
      assert.equal(run.code, EXIT.auth, run.stdout);
      assert.equal(errorOf(run.stdout).code, code);
      assert.equal(origin.seen.length, 1, "auth failures are not retried");
    });
  }
});

await test("a redirect to another origin never carries the credential", async () => {
  await withOrigin((_, response) => { sendJson(response, []); }, async other => {
    await withOrigin((_, response) => { response.writeHead(307, { location: `${other.origin}/api/v1/projects` }).end(); }, async origin => {
      const run = await jsonRun(origin, ["projects"]);
      assert.equal(run.code, EXIT.auth);
      assert.equal(other.seen.length, 0);
      assert.equal(other.connections(), 0);
      assert.ok(!run.stdout.includes(TOKEN) && !run.stderr.includes(TOKEN));
    });
  });
});

await test("malformed JSON, a wrong shape, and an oversized body are contract failures with exit 4", async () => {
  const replies: [string, Handler][] = [
    ["malformed_json", (_, response) => { response.writeHead(200, { "content-type": "application/json" }); response.end("{not json"); }],
    ["contract", (_, response) => { sendJson(response, [{ id: "stats" }]); }],
    ["contract", (_, response) => { sendJson(response, { projects: [] }); }],
    ["body_too_large", (_, response) => { response.writeHead(200, { "content-type": "application/json" }); response.end(`[${" ".repeat(1024 * 1024 + 10)}]`); }],
    ["not_found", (_, response) => { response.writeHead(404).end(); }]
  ];
  for (const [code, handler] of replies) {
    await withOrigin(handler, async origin => {
      const run = await jsonRun(origin, ["projects"]);
      assert.equal(run.code, EXIT.transport, run.stdout);
      assert.equal(errorOf(run.stdout).code, code);
      assert.equal(document(run.stdout)["command"], "projects");
    });
  }
});

await test("failure output is exactly one document on stdout and a diagnostic on stderr", async () => {
  await withOrigin((_, response) => { response.writeHead(401).end(); }, async origin => {
    const run = await jsonRun(origin, ["health", "--project", "stats"]);
    assert.equal(run.code, EXIT.auth);
    assert.equal(run.stdout.trimEnd().split("\n").filter(line => line.startsWith('{')).length, 1);
    assert.equal(document(run.stdout)["schema"], "statsctl/1");
    assert.match(run.stderr, /statsctl:/u);
  });
});

await test("only GET network-class failures are retried, at most twice", async () => {
  let calls = 0;
  await withOrigin((_, response) => {
    calls += 1;
    if (calls <= 2) return void response.writeHead(503).end();
    sendJson(response, [projectEntry("stats")]);
  }, async origin => {
    const run = await jsonRun(origin, ["projects"]);
    assert.equal(run.code, EXIT.ok, run.stdout);
    assert.equal(origin.seen.length, 3);
  });
  await withOrigin((_, response) => { response.writeHead(502).end(); }, async origin => {
    const run = await jsonRun(origin, ["projects"]);
    assert.equal(run.code, EXIT.transport);
    assert.equal(errorOf(run.stdout).code, "http_502");
    assert.equal(origin.seen.length, 3);
  });
});

await test("a missing credential exits 3 and says how to log in, without starting a login", async () => {
  await withOrigin((_, response) => { sendJson(response, []); }, async origin => {
    for (const command of ["exit 1", "printf ''", "sleep 0.01; exit 3"]) {
      const run = await jsonRun(origin, ["projects"], { STATSCTL_AUTH_COMMAND: command });
      assert.equal(run.code, EXIT.auth);
      assert.equal(errorOf(run.stdout).code, "credential_unavailable");
      assert.ok(errorOf(run.stdout).message.includes(`run: cf access login ${origin.origin}`));
      assert.equal(origin.connections(), 0);
    }
  });
});

await test("the credential header name is configurable and the token never reaches argv", async () => {
  await withOrigin((request, response) => {
    if (request.headers["x-access"] !== TOKEN) return void response.writeHead(401).end();
    sendJson(response, []);
  }, async origin => {
    const run = await jsonRun(origin, ["projects"], { STATSCTL_AUTH_HEADER: "x-access" });
    assert.equal(run.code, EXIT.ok, run.stdout);
    assert.equal(origin.seen[0]?.headers["cf-access-token"], undefined);
    const bad = await jsonRun(origin, ["projects"], { STATSCTL_AUTH_HEADER: "bad header" });
    assert.equal(bad.code, EXIT.usage);
    assert.equal(errorOf(bad.stdout).code, "usage");
  });
});

function healthOrigin(overrides: { deployments?: Handler; health?: Handler; projects?: unknown } = {}): Handler {
  const now = Date.now();
  return (request, response, seen) => {
    if (!authorized(request)) return void response.writeHead(401).end();
    const url = request.url ?? "";
    if (url === "/api/v1/projects") return sendJson(response, overrides.projects ?? [projectEntry("stats"), projectEntry("other")]);
    if (url.endsWith("/deployments")) {
      if (overrides.deployments !== undefined) return overrides.deployments(request, response, seen);
      return sendJson(response, deploymentHistory(url.split("/")[4] ?? ""));
    }
    if (url === "/api/observe/stats/health") {
      if (overrides.health !== undefined) return overrides.health(request, response, seen);
      return sendJson(response, observeHealth(now - 60_000));
    }
    response.writeHead(404).end();
  };
}

await test("health reports collector, deployment sync, and observe independently as healthy", async () => {
  await withOrigin(healthOrigin(), async origin => {
    const run = await jsonRun(origin, ["health", "--project", "stats"]);
    assert.equal(run.code, EXIT.ok, run.stdout + run.stderr);
    const parsed = document(run.stdout);
    assert.equal(parsed["project"], "stats");
    const payload = parsed["payload"] as Record<string, { state: string; reasons: unknown[] }>;
    assert.equal(payload["collector"]?.state, "healthy");
    assert.equal(payload["deployments"]?.state, "healthy");
    assert.equal(payload["observe"]?.state, "healthy");
    assert.deepEqual(payload["readiness"], { policy: null, signals: [] });
    assert.deepEqual(origin.seen.map(seen => seen.url).sort(), ["/api/observe/stats/health", "/api/v1/projects", "/api/v1/projects/stats/deployments"]);
  });
});

await test("a 200 alone is not healthy, and one failing section does not hide the others", async () => {
  const stale = { collector: { lastRunAtMs: 1, lastSuccessAtMs: null, lastError: "quota", stale: true } };
  await withOrigin(healthOrigin({
    projects: [projectEntry("stats", stale)],
    deployments: (_, response) => { response.writeHead(503).end(); },
    health: (_, response) => { sendJson(response, observeHealth(Date.now() - 3 * 3_600_000)); }
  }), async origin => {
    const run = await jsonRun(origin, ["health", "--project", "stats"]);
    assert.equal(run.code, EXIT.ok, run.stdout + run.stderr);
    const parsed = document(run.stdout);
    const payload = parsed["payload"] as Record<string, { state: string; reasons: { code: string }[] }>;
    assert.equal(payload["collector"]?.state, "unhealthy");
    assert.deepEqual(payload["collector"]?.reasons.map(reason => reason.code), ["collector_never_succeeded", "collector_stale", "collector_error"]);
    assert.equal(payload["deployments"]?.state, "unavailable");
    assert.deepEqual(payload["deployments"]?.reasons.map(reason => reason.code), ["http_503"]);
    assert.equal(payload["observe"]?.state, "unhealthy");
    assert.deepEqual(payload["observe"]?.reasons.map(reason => reason.code), ["events_stale"]);
    assert.deepEqual((parsed["warnings"] as { code: string }[]).map(warning => warning.code), ["http_503"]);
  });
});

await test("deployment sync problems and truncation are reasons, not a pass", async () => {
  await withOrigin(healthOrigin({
    deployments: (_, response) => { sendJson(response, deploymentHistory("stats", { sync: { lastAttemptAtMs: 5, lastSuccessAtMs: 4, error: "api", truncated: true } })); }
  }), async origin => {
    const run = await jsonRun(origin, ["health", "--project", "stats"]);
    const payload = document(run.stdout)["payload"] as Record<string, { state: string; reasons: { code: string }[] }>;
    assert.equal(payload["deployments"]?.state, "unhealthy");
    assert.deepEqual(payload["deployments"]?.reasons.map(reason => reason.code), ["sync_error", "history_truncated"]);
  });
});

await test("only stats is observed; other projects report unavailable:not_observed without an observe request", async () => {
  await withOrigin(healthOrigin(), async origin => {
    const run = await jsonRun(origin, ["health", "--project", "other"]);
    assert.equal(run.code, EXIT.ok, run.stdout);
    const payload = document(run.stdout)["payload"] as Record<string, { state: string; reasons: { code: string }[] }>;
    assert.equal(payload["observe"]?.state, "unavailable");
    assert.deepEqual(payload["observe"]?.reasons.map(reason => reason.code), ["not_observed"]);
    assert.ok(origin.seen.every(seen => !seen.url.startsWith("/api/observe")));
    const text = await runCli(["health", "--project", "other", "--origin", origin.origin], tokenEnv());
    assert.match(text.stdout, /observe: unavailable\n  not_observed:/u);
  });
});

await test("health on an unknown project is a usage error and a total outage reports the first failure", async () => {
  await withOrigin(healthOrigin(), async origin => {
    const run = await jsonRun(origin, ["health", "--project", "ghost"]);
    assert.equal(run.code, EXIT.usage);
    assert.match(errorOf(run.stdout).message, /known: other, stats/u);
  });
  await withOrigin((_, response) => { response.writeHead(500).end(); }, async origin => {
    const run = await jsonRun(origin, ["health", "--project", "stats"]);
    assert.equal(run.code, EXIT.transport);
    assert.equal(errorOf(run.stdout).code, "http_500");
  });
});

await test("an observe payload that fails the strict decoder is a contract reason", async () => {
  await withOrigin(healthOrigin({ health: (_, response) => { sendJson(response, { newestAtMs: "now" }); } }), async origin => {
    const run = await jsonRun(origin, ["health", "--project", "stats"]);
    assert.equal(run.code, EXIT.ok);
    const payload = document(run.stdout)["payload"] as Record<string, { state: string; reasons: { code: string }[] }>;
    assert.equal(payload["observe"]?.state, "unavailable");
    assert.deepEqual(payload["observe"]?.reasons.map(reason => reason.code), ["contract"]);
  });
});
