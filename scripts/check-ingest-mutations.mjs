import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const installation = "cloudflare/src/core/installation/installation.ts";
const expectedSource = "6cd12af03baf59f3c99a7a6cc34c958118b6c69d0bae8d1fdf23528ed87eccae";
const equivalentSource = createHash("sha256").update(readFileSync(installation)).digest("hex") === expectedSource;
const equivalent = new Map([
  ["OptionalChaining", [20, 37, "rejected[0].code"]],
  ["StringLiteral", [41, 57, '""']],
]);
const report = JSON.parse(readFileSync(".work/tmp/ingest-mutation-worker.json", "utf8"));
const expectedFiles = [installation, "cloudflare/src/ingest/ack.ts"];
let failed = false;
for (const file of expectedFiles) {
  const mutants = report.files?.[file]?.mutants;
  if (!Array.isArray(mutants) || mutants.length === 0 || new Set(mutants.map(mutant => mutant.id)).size !== mutants.length) {
    throw new Error(`missing or invalid mutation inventory: ${file}`);
  }
  for (const mutant of mutants) {
    const { status, mutatorName, replacement, location } = mutant;
    const disposition = file === installation && equivalentSource ? equivalent.get(mutatorName) : undefined;
    const isEquivalent = status === "Survived" && disposition !== undefined
      && location.start.line === 630 && location.end.line === 630
      && location.start.column === disposition[0] && location.end.column === disposition[1]
      && replacement === disposition[2];
    const outcome = isEquivalent ? "Equivalent" : status;
    console.log(`${file}:${location.start.line}:${location.start.column} id=${mutant.id} ${outcome}`);
    failed ||= outcome !== "Equivalent" && outcome !== "Killed";
  }
}
process.exitCode = failed ? 1 : 0;
