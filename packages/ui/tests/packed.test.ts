import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "vitest";

describe("packed artifact contract", () => {
  const uiDir = resolve(import.meta.dirname, "..");
  const distDir = resolve(uiDir, "dist");

  it("produces an npm tarball with expected manifest and distribution files", () => {
    const tmp = mkdtempSync(join(tmpdir(), "ui-pack-"));
    try {
      const output = execSync("npm pack --json", { cwd: uiDir, encoding: "utf8" });
      const jsonStart = output.indexOf("{");
      const jsonEnd = output.lastIndexOf("}") + 1;
      const data = JSON.parse(output.slice(jsonStart, jsonEnd)) as Record<string, { filename: string; files: readonly { path: string }[] }>;
      const tarballInfo = data["@joshuarli/ui"] ?? Object.values(data)[0];
      assert.ok(tarballInfo !== undefined, "Expected tarball info in json output");
      assert.equal(tarballInfo.filename, "joshuarli-ui-0.2.0.tgz");

      const paths = tarballInfo.files.map(f => f.path);
      assert.ok(paths.includes("package.json"), "Missing package.json");
      assert.ok(paths.includes("README.md"), "Missing README.md");
      assert.ok(paths.includes("dist/index.js"), "Missing dist/index.js");
      assert.ok(paths.includes("dist/index.d.ts"), "Missing dist/index.d.ts");
      assert.ok(paths.includes("dist/styles.css"), "Missing dist/styles.css");
      assert.ok(paths.includes("dist/tokens.css"), "Missing dist/tokens.css");
      assert.ok(paths.includes("dist/components/Badge.d.ts"), "Missing Badge declaration");
      assert.ok(paths.includes("dist/components/Panel.d.ts"), "Missing Panel declaration");
      assert.ok(paths.includes("dist/components/Modal.d.ts"), "Missing Modal declaration");

      rmSync(join(uiDir, tarballInfo.filename), { force: true });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("exports all required primitives in compiled ESM index.js", () => {
    const js = readFileSync(resolve(distDir, "index.js"), "utf8");
    const expectedExports = [
      "Badge",
      "Button",
      "IconButton",
      "Panel",
      "CollapsiblePanel",
      "Modal",
      "Segmented",
      "EmptyState",
      "ErrorState",
      "Notice",
      "Skeleton",
      "Pagination",
      "Meter",
      "PageHeader",
      "Icon",
      "Shell"
    ];

    for (const name of expectedExports) {
      assert.match(js, new RegExp(`\\b${name}\\b`, "u"), `Expected export ${name} in index.js`);
    }
  });

  it("provides valid TypeScript declaration files", () => {
    const dts = readFileSync(resolve(distDir, "index.d.ts"), "utf8");
    assert.match(dts, /export \{ Badge/u);
    assert.match(dts, /export \{ Panel, CollapsiblePanel/u);
    assert.match(dts, /export \{ Modal/u);
    assert.match(dts, /export \{ Segmented/u);
    assert.match(dts, /export \{ EmptyState/u);
    assert.match(dts, /export \{ ErrorState/u);
    assert.match(dts, /export \{ Notice/u);
    assert.match(dts, /export \{ Skeleton/u);
    assert.match(dts, /export \{ Pagination/u);
    assert.match(dts, /export \{ Meter/u);
    assert.match(dts, /export \{ PageHeader/u);
    assert.match(dts, /export \{ Icon/u);
  });

  it("ships tokens.css with namespaced --ui-* variables", () => {
    const tokens = readFileSync(resolve(distDir, "tokens.css"), "utf8");
    assert.match(tokens, /--ui-bg:/u);
    assert.match(tokens, /--ui-surface:/u);
    assert.match(tokens, /--ui-text:/u);
    assert.match(tokens, /--ui-line:/u);
    assert.match(tokens, /--ui-accent:/u);
    assert.match(tokens, /--ui-radius-md:/u);
  });

  it("ships styles.css with namespaced .ui-* class rules", () => {
    const styles = readFileSync(resolve(distDir, "styles.css"), "utf8");
    assert.match(styles, /\.ui-btn/u);
    assert.match(styles, /\.ui-badge/u);
    assert.match(styles, /\.ui-panel/u);
    assert.match(styles, /\.ui-modal/u);
    assert.match(styles, /\.ui-segmented/u);
    assert.match(styles, /\.ui-empty-state/u);
    assert.match(styles, /\.ui-error-state/u);
    assert.match(styles, /\.ui-notice/u);
    assert.match(styles, /\.ui-skeleton/u);
    assert.match(styles, /\.ui-pagination/u);
    assert.match(styles, /\.ui-meter/u);
    assert.match(styles, /\.ui-shell/u);
    assert.match(styles, /\.ui-side-nav a\[aria-current\]/u);
  });

  it("overrides every color token in the dark scheme and keeps light unchanged", () => {
    const tokens = readFileSync(resolve(distDir, "tokens.css"), "utf8");
    const darkStart = tokens.indexOf("@media (prefers-color-scheme: dark)");
    assert.ok(darkStart > 0, "Missing dark scheme block");
    assert.match(tokens, /color-scheme: light dark;/u);
    const light = tokens.slice(0, darkStart);
    const dark = tokens.slice(darkStart);
    const isColor = (value: string): boolean => /^(#|rgb)/u.test(value);
    const lightColors = [...light.matchAll(/(--ui-[\w-]+):\s*([^;]+);/gu)]
      .filter(match => isColor(match[2] ?? ""))
      .map(match => match[1] ?? "");
    assert.ok(lightColors.length > 20);
    for (const name of lightColors) {
      assert.match(dark, new RegExp(`${name}:`, "u"), `Dark scheme is missing ${name}`);
    }
  });

  it("declares solid-js and @solidjs/web as optional peers", () => {
    const manifest = JSON.parse(readFileSync(resolve(uiDir, "package.json"), "utf8")) as {
      peerDependenciesMeta: Record<string, { optional: boolean }>;
    };
    assert.equal(manifest.peerDependenciesMeta["solid-js"]?.optional, true);
    assert.equal(manifest.peerDependenciesMeta["@solidjs/web"]?.optional, true);
  });
});
