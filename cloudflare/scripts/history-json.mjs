#!/usr/bin/env node
/** Reads a history frame from stdin and writes the JSON-shaped history it was built from. */
import { readHistory } from "../test/support/history.ts";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
process.stdout.write(JSON.stringify(readHistory(Buffer.concat(chunks))));
