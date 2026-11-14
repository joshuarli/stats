import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");

export function devWorkspace(): { readonly repo: string; readonly root: string; remove(): void } {
  const repo = mkdtempSync(resolve(ROOT, "../.work/tmp/dev-workspace-"));
  const root = join(repo, "cloudflare");
  mkdirSync(root);
  for (const directory of ["src", "scripts", "local", "public"]) cpSync(join(ROOT, directory), join(root, directory), { recursive: true });
  for (const file of ["package.json", "tsconfig.json", "index.html", "cloudflare.config.ts", "vite.config.ts", "vite.node.config.ts", "wrangler.test.jsonc"]) copyFileSync(join(ROOT, file), join(root, file));
  mkdirSync(join(root, "observe-worker"));
  for (const file of ["cloudflare.config.ts", "vite.config.ts"]) copyFileSync(join(ROOT, "observe-worker", file), join(root, "observe-worker", file));
  for (const file of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".node-version"]) copyFileSync(resolve(ROOT, "..", file), join(repo, file));
  cpSync(resolve(ROOT, "../fixtures/v2"), join(repo, "fixtures/v2"), { recursive: true });
  mkdirSync(join(repo, "docs"));
  for (const file of ["protocol.md", "architecture.md"]) copyFileSync(resolve(ROOT, "../docs", file), join(repo, "docs", file));
  symlinkSync(join(ROOT, "node_modules"), join(root, "node_modules"), "dir");
  symlinkSync(resolve(ROOT, "../node_modules"), join(repo, "node_modules"), "dir");
  return { repo, root, remove: () => rmSync(repo, { recursive: true, force: true }) };
}
