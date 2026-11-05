import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCRATCH } from "../../local/stack.ts";
import { STATS_OUTPUT } from "../../local/topology.ts";

export interface PlantedOutput {
  readonly output: string;
  remove(): void;
}

export function plantStatsOutput(edit: (bundle: string) => string): PlantedOutput {
  mkdirSync(SCRATCH, { recursive: true });
  const output = mkdtempSync(join(SCRATCH, "planted-"));
  cpSync(STATS_OUTPUT, output, { recursive: true });
  const bundle = join(output, "bundle/index.js");
  writeFileSync(bundle, edit(readFileSync(bundle, "utf8")));
  return { output, remove: () => rmSync(output, { recursive: true, force: true }) };
}

export function plantBeside(anchor: string, planted: string): (bundle: string) => string {
  return bundle => {
    if (bundle.split(anchor).length !== 2) throw new Error(`the built bundle does not contain exactly one ${JSON.stringify(anchor)}`);
    return bundle.replace(anchor, `${planted}\n${anchor}`);
  };
}
