import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { route } from "../../src/cli/run.ts";
import { CLOUDFLARE_DIR, runCli } from "./support.ts";

const REPOSITORY_DIR = join(CLOUDFLARE_DIR, "..");
const RUNNER_PREFIXES = [
  "pnpm --dir cloudflare -s statsctl ",
  "node --experimental-strip-types cloudflare/src/cli/statsctl.ts "
];
const SHORT_PREFIX = "statsctl ";

const DOCUMENTS = ["cloudflare/public/llms.txt", "AGENTS.md", "docs/operations.md", "docs/observe-billing.md"];

function invocationArguments(text: string, short: boolean): string[] | undefined {
  const trimmed = text.trim();
  for (const prefix of short ? [...RUNNER_PREFIXES, SHORT_PREFIX] : RUNNER_PREFIXES) {
    if (!trimmed.startsWith(prefix)) continue;
    const command = trimmed.slice(prefix.length).split(/\s[>#]\s/u)[0] ?? "";
    const words = command.split(/\s+/u).filter(word => word.length > 0);
    return words[0]?.endsWith(":") === true ? undefined : words;
  }
  return undefined;
}

function invocationsIn(text: string, document: boolean): string[][] {
  const found: string[][] = [];
  for (const line of text.split("\n")) {
    const candidates = document ? [...line.matchAll(/`([^`]+)`/gu)].map(match => match[1] ?? "") : [];
    for (const candidate of [line, ...candidates]) {
      const args = invocationArguments(candidate, document);
      if (args !== undefined) found.push(args);
    }
  }
  return found;
}

function assertParses(source: string, invocations: readonly string[][]): void {
  assert.ok(invocations.length > 0, `${source} has no statsctl command examples`);
  for (const args of invocations) {
    assert.doesNotThrow(() => route(args), `${source}: statsctl ${args.join(" ")}`);
  }
}

await test("every command in statsctl help workflow parses", async () => {
  const run = await runCli(["help", "workflow"], {});
  assert.equal(run.code, 0, run.stderr);
  assertParses("statsctl help workflow", invocationsIn(run.stdout, false));
});

for (const document of DOCUMENTS) {
  await test(`every statsctl command in ${document} parses`, () => {
    const text = readFileSync(join(REPOSITORY_DIR, document), "utf8");
    assertParses(document, invocationsIn(text, true));
  });
}
