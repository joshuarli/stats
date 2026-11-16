import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium } from "@playwright/test";

if (process.argv.includes("--probe")) {
  assert.equal(Object.keys(process.env).some(name => name.startsWith("CF_") || name.startsWith("CLOUDFLARE_")), false);
  const server = createServer((_request, response) => { response.end("<html><body>offline loopback</body></html>"); });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch();
  try {
    assert.equal(await (await fetch(origin)).text(), "<html><body>offline loopback</body></html>");
    for (const external of ["http://1.1.1.1", "http://[2606:4700:4700::1111]"]) {
      await assert.rejects(fetch(external, { signal: AbortSignal.timeout(2000) }));
    }
    const page = await browser.newPage();
    await page.goto(origin);
    assert.equal(await page.locator("body").innerText(), "offline loopback");
    assert.equal(await page.evaluate(async () => {
      try { await fetch("http://1.1.1.1", { mode: "no-cors", signal: AbortSignal.timeout(2000) }); return true; }
      catch { return false; }
    }), false);
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
  }
} else {
  await test("the OS sandbox permits loopback and Chromium, denies outbound network and strips provider credentials", { timeout: 45000 }, () => {
    const script = fileURLToPath(new URL("../../../scripts/offline-run.sh", import.meta.url));
    const child = spawnSync(script, [process.execPath, "--experimental-strip-types", import.meta.filename, "--probe"], {
      env: { ...process.env, CF_OFFLINE_CANARY: "canary", CLOUDFLARE_OFFLINE_CANARY: "canary" }, encoding: "utf8", timeout: 40000
    });
    assert.equal(child.status, 0, child.error?.message ?? child.stderr);
  });
}
