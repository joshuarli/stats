import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "../..");
const ADAPTER_DIRECTORIES = ["src/cloudflare/", "src/observe/cloudflare/"];
const ADAPTER_PACKAGES = /^(cloudflare:|@cloudflare\/)/u;
const SOURCE = /\.(ts|tsx)$/u;
const SPECIFIER = /\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gu;
const DYNAMIC_IMPORT = /\bimport\(\s*(?!["'])/u;

function repoPath(path: string): string {
  return relative(ROOT, path).split(sep).join("/");
}

function isAdapter(path: string): boolean {
  return ADAPTER_DIRECTORIES.some(directory => repoPath(path).startsWith(directory));
}

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? sources(path) : SOURCE.test(name) ? [path] : [];
  });
}

function resolveRelative(from: string, specifier: string): string {
  const base = join(dirname(from), specifier);
  const found = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")].find(candidate => existsSync(candidate) && statSync(candidate).isFile());
  if (found === undefined) throw new Error(`${repoPath(from)} imports ${specifier}, which does not resolve`);
  return found;
}

function adapterImports(path: string): string[] {
  const text = readFileSync(path, "utf8");
  if (DYNAMIC_IMPORT.test(text)) throw new Error(`${repoPath(path)} has a dynamic import this test cannot follow`);
  return [...text.matchAll(SPECIFIER)]
    .map(match => match[1] ?? match[2] ?? match[3]!)
    .filter(specifier => ADAPTER_PACKAGES.test(specifier) || (specifier.startsWith(".") && isAdapter(resolveRelative(path, specifier))))
    .map(specifier => `${repoPath(path)} -> ${specifier}`);
}

await test("no module outside src/cloudflare/ and src/observe/cloudflare/ imports Cloudflare adapter code or a Cloudflare runtime module", () => {
  const core = sources(join(ROOT, "src")).filter(path => !isAdapter(path));
  assert.deepEqual(core.flatMap(adapterImports), []);
});
