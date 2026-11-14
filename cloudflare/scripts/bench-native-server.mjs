#!/usr/bin/env node
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { openAssets } from '../src/node/assets.ts';

const USAGE = 'usage: node scripts/bench-native-server.mjs --assets DIR --upstream https://stats.17166969.xyz [--port PORT]';
const MAX_BYTES = 32 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const requestHeaders = ['accept', 'accept-encoding', 'if-none-match', 'if-modified-since'];
const hopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-encoding', 'content-length', 'set-cookie']);

export async function createBenchServer({ assetsDir, upstream, port = 0, fetchImpl = fetch, timeoutMs = TIMEOUT_MS, maxBytes = MAX_BYTES }) {
  const assets = await openAssets(assetsDir);
  const origin = new URL(upstream);
  const controllers = new Set();
  const server = createServer(async (req, res) => {
    if (req.headers.host !== `127.0.0.1:${server.address().port}`) { res.writeHead(403).end(); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
    if (!req.url?.startsWith('/') || req.url.startsWith('//') || req.url.includes('\\')) { res.writeHead(400).end(); return; }
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/health' || url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      const controller = new AbortController();
      controllers.add(controller);
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const cancel = () => { if (!res.writableFinished) controller.abort(); };
      res.on('close', cancel);
      try {
        const headers = Object.fromEntries(requestHeaders.filter(name => req.headers[name] !== undefined).map(name => [name, req.headers[name]]));
        const response = await fetchImpl(new URL(url.pathname + url.search, origin), { method: req.method, headers, redirect: 'manual', signal: controller.signal });
        const length = Number(response.headers.get('content-length'));
        if (Number.isFinite(length) && length > maxBytes) throw new Error('upstream response too large');
        const chunks = [];
        let size = 0;
        if (response.body) for await (const chunk of response.body) {
          size += chunk.byteLength;
          if (size > maxBytes) throw new Error('upstream response too large');
          chunks.push(chunk);
        }
        const outHeaders = Object.fromEntries([...response.headers].filter(([name]) => !hopHeaders.has(name)));
        res.writeHead(response.status, outHeaders).end(Buffer.concat(chunks));
      } catch {
        if (!res.headersSent && !res.destroyed) res.writeHead(502).end('Upstream request failed');
      } finally {
        clearTimeout(timer); controllers.delete(controller); res.off('close', cancel);
      }
      return;
    }
    try {
      const response = await assets(new Request(url, { method: req.method }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) Readable.fromWeb(response.body).pipe(res); else res.end();
    } catch { if (!res.headersSent) res.writeHead(500).end(); else res.destroy(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { server, close: async () => { for (const controller of controllers) controller.abort(); server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log(USAGE); process.exit(0); }
  const value = name => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; };
  const assetsDir = value('--assets');
  const upstream = value('--upstream');
  const port = Number(value('--port') ?? '0');
  if (!assetsDir || upstream !== 'https://stats.17166969.xyz' || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error(USAGE);
  const instance = await createBenchServer({ assetsDir, upstream, port });
  console.log(`http://127.0.0.1:${instance.server.address().port}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void instance.close().then(() => process.exit(0)); });
}
