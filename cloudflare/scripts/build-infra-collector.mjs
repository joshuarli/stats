#!/usr/bin/env node
import { build } from 'vite';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
const { values } = parseArgs({ options: { out: { type: 'string' } } });
if (!values.out) throw new Error('usage: node cloudflare/scripts/build-infra-collector.mjs --out DIRECTORY');
const root = resolve(import.meta.dirname, '../..'), out = resolve(values.out);
if (!out.startsWith(resolve(root, '.work/tmp') + '/')) throw new Error('collector build output must be under repository .work/tmp');
await mkdir(out, { recursive: true });
await build({ configFile: false, root, logLevel: 'warn', build: { ssr: resolve(root, 'packages/infra-collector/src/main.ts'), outDir: out, emptyOutDir: true, minify: false, rolldownOptions: { output: { entryFileNames: 'main.mjs' } } } });
const artifact = await readFile(resolve(out, 'main.mjs'));
const result = { node: process.version, bytes: artifact.length, sha256: createHash('sha256').update(artifact).digest('hex') };
await writeFile(resolve(out, 'manifest.json'), JSON.stringify(result) + '\n');
console.log(JSON.stringify(result));
