#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { HISTORY_CONTENT_TYPE } from "../src/binary/history.ts";
import { readHistory } from "../test/support/history.ts";

const target = process.argv[2];
if (target === undefined || !target.startsWith("/") || process.argv.length > 3) {
  process.stderr.write("usage: scripts/api.mjs /hosts | '/hosts/<id>/history?range=1h&kinds=summary,disks'\n");
  process.exit(2);
}
const base = process.env.STATS_URL ?? "https://stats.17166969.xyz";
const path = target.startsWith("/api/") ? target : `/api/v1${target}`;
const token = execFileSync("cf", ["access", "token", base], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
const response = await fetch(`${base}${path}`, { headers: { "cf-access-token": token } });
const type = (response.headers.get("content-type") ?? "").split(";")[0].trim();
const body = Buffer.from(await response.arrayBuffer());
if (!response.ok) {
  process.stderr.write(`${response.status} ${path}\n${body.toString("utf8")}\n`);
  process.exit(1);
}
process.stdout.write(type === HISTORY_CONTENT_TYPE ? JSON.stringify(readHistory(body)) : body.toString("utf8"));
process.stdout.write("\n");
