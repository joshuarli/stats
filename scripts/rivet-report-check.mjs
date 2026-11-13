#!/usr/bin/env node
// report --check for CAMPAIGN-RIVET-OPENORANGE: validates that the evaluation
// record is complete. It checks the record, not the candidate; it cannot turn a
// failing candidate command into a pass, and it fails when a required artifact
// or verdict is missing.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
const EVALUATION = join(REPO, "docs", "rivet-openorange-evaluation.md");
const REGISTER = join(REPO, "docs", "rivet-openorange-behavior-register.md");
const CAMPAIGN = join(REPO, "docs", "CAMPAIGN-RIVET-OPENORANGE.md");
const EVIDENCE_DIR = join(REPO, "docs", "rivet-openorange");
const REQUIRED_EVIDENCE = ["baseline.json", "bootstrap.json", "pilot.json", "parity.json", "native.json", "resilience.json", "soak.json"];
const REQUIRED_SECTIONS = ["## Environment note", "## Baseline (A)", "## Candidate closure", "## R1", "## R2", "## R3", "## R4", "## R5", "## R6", "## R7", "## Required behavior inventory", "## Needs environment", "## Verdict"];

export function checkEvidence(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed.result === "string" && typeof parsed.revision === "string" ? { ok: true, result: parsed.result, revision: parsed.revision } : { ok: false, detail: "missing result or revision" };
  } catch (error) {
    return { ok: false, detail: String(error?.message ?? error).slice(0, 200) };
  }
}

export function runReportCheck() {
  const checks = [];
  const add = (name, ok, detail = undefined) => checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) });

  for (const file of REQUIRED_EVIDENCE) {
    const path = join(EVIDENCE_DIR, file);
    if (!existsSync(path)) { add(`evidence:${file}`, false, "missing"); continue; }
    const outcome = checkEvidence(path);
    add(`evidence:${file}`, outcome.ok, outcome.ok ? `result ${outcome.result} at ${outcome.revision}` : outcome.detail);
  }

  if (!existsSync(EVALUATION)) add("evaluation-report", false, "missing");
  else {
    const text = readFileSync(EVALUATION, "utf8");
    for (const section of REQUIRED_SECTIONS) add(`section:${section}`, text.includes(section), text.includes(section) ? undefined : "missing section");
    add("verdict:local-default", /local default/i.test(text), undefined);
    add("verdict:self-host-path", /self-host path/i.test(text), undefined);
  }

  if (!existsSync(REGISTER)) add("behavior-register", false, "missing");
  else {
    const text = readFileSync(REGISTER, "utf8");
    add("register:no-pending-rows", !text.includes("| pending |"), text.includes("| pending |") ? "behavior register still lists pending rows" : undefined);
  }

  if (!existsSync(CAMPAIGN)) add("campaign-doc", false, "missing");
  else add("campaign-doc", readFileSync(CAMPAIGN, "utf8").includes("R7"), undefined);

  const failed = checks.filter(check => !check.ok);
  return {
    schema: "rivet-eval/1",
    command: "report",
    result: failed.length === 0 ? "pass" : "fail",
    reason: failed.length === 0 ? null : `incomplete evaluation record: ${failed.map(check => check.name).join("; ")}`,
    checks,
  };
}

if (import.meta.main) {
  const outcome = runReportCheck();
  process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
  process.exitCode = outcome.result === "pass" ? 0 : 1;
}
