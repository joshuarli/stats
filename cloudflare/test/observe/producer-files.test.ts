import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { posix } from "node:path";

const ROOT = new URL("../../src/observe/", import.meta.url);
const FILES = ["producer/channel.ts", "producer/report.ts", "cloudflare/mark.ts"] as const;
const EXTERNAL: ReadonlySet<string> = new Set(["node:diagnostics_channel", "cloudflare:workers"]);
const SPECIFIER = /(?:^|[\s;])(?:import|export)\b[^'"`;]*?\bfrom\s*["']([^"']+)["']|(?:^|[\s;])import\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']|\brequire\s*\(\s*["']([^"']+)["']/gmu;

function specifiers(source: string): string[] {
  return [...source.matchAll(SPECIFIER)].map(match => match[1] ?? match[2] ?? match[3] ?? match[4]!);
}

await test("the producer files import only each other, diagnostics_channel, and cloudflare:workers", () => {
  for (const file of FILES) {
    const found = specifiers(readFileSync(new URL(file, ROOT), "utf8"));
    for (const specifier of found) {
      const allowed = EXTERNAL.has(specifier) || (specifier.startsWith(".") && (FILES as readonly string[]).includes(posix.join(posix.dirname(file), specifier)));
      assert.ok(allowed, `${file} imports ${specifier}`);
    }
  }
});

await test("the import scanner sees static, type, side-effect, dynamic, and re-export forms", () => {
  const source = [
    'import type { A } from "../../x.ts";', 'import { B, type C } from "./b.ts";', 'import "./side.ts";',
    'export { D } from "./d.ts";', 'export * from "./e.ts";', 'const f = await import("./f.ts");',
    'import {\n  G,\n  H\n} from "./g.ts";'
  ].join("\n");
  assert.deepEqual(specifiers(source), ["../../x.ts", "./b.ts", "./side.ts", "./d.ts", "./e.ts", "./f.ts", "./g.ts"]);
});
