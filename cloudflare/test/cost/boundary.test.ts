import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const source = join(root, "src");
const FORBIDDEN_PACKAGES = [/^solid-js(\/|$)/u, /^@solidjs\//u, /^uplot(\/|$)/u];
const IMPORT = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+"([^"]+)"|(?:^|\n)\s*import\s+"([^"]+)"|\bimport\(\s*"([^"]+)"\s*\)/gu;

function entries(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(".ts"))
    .map(entry => join(entry.parentPath, entry.name));
}

function specifiers(file: string): string[] {
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(IMPORT)].map(match => match[1] ?? match[2] ?? match[3]!);
}

function violations(roots: readonly string[]): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const pending = [...roots];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const name = relative(root, file);
    const insideCost = file.startsWith(join(source, "cost") + "/");
    for (const specifier of specifiers(file)) {
      if (!specifier.startsWith(".")) {
        if (FORBIDDEN_PACKAGES.some(pattern => pattern.test(specifier))) found.push(`${name} imports ${specifier}`);
        continue;
      }
      if (!specifier.endsWith(".ts")) {
        found.push(`${name} imports ${specifier} without an explicit .ts extension`);
        continue;
      }
      const target = resolve(dirname(file), specifier);
      const shown = relative(root, target);
      if (target.startsWith(join(source, "client", "pages") + "/")) found.push(`${name} imports ${shown} under src/client/pages`);
      if (!statSync(target, { throwIfNoEntry: false })?.isFile()) found.push(`${name} imports ${shown}, which does not exist`);
      else pending.push(target);
    }
    if (insideCost && file.endsWith(".tsx")) found.push(`${name} is a .tsx module`);
  }
  return found.sort();
}

await test("the cost module reaches no UI framework, JSX module, or page module", () => {
  const roots = entries(join(source, "cost"));
  assert.ok(roots.length > 0);
  assert.deepEqual(violations(roots), []);
});

await test("the command line reaches no UI framework, JSX module, or page module", () => {
  assert.deepEqual(violations(entries(join(source, "cli"))), []);
});

await test("the walker flags a page that imports solid-js", () => {
  const found = violations([join(source, "client", "pages", "project", "CostLedger.tsx")]);
  assert.ok(found.some(entry => entry.endsWith("imports solid-js")));
});
