// Rollout authority_check for the standby Stats writer (see docs/openorange.md).
//   node deploy/orange/writer-authority.mjs --route-host HOST
// Prints {"ok": true, "authority": ROUTE} when HOST's recovery route names the
// standby as the Stats writer; the controller compares ROUTE before preparation
// and again before activation.
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--route-host' || !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(args[1])) {
  console.error('usage: node deploy/orange/writer-authority.mjs --route-host HOST');
  process.exit(2);
}
const read = spawnSync('ssh', ['-o', 'BatchMode=yes', args[1], 'doas', '-n', 'cat', '/etc/openorange/recovery-routes.json'], { encoding: 'utf8', timeout: 20000 });
let route;
try {
  if (read.error || read.status !== 0) throw new Error(`cannot read the recovery route from ${args[1]}`);
  route = JSON.parse(read.stdout).stats;
  if (route === null || typeof route !== 'object' || Array.isArray(route)) throw new Error('recovery route has no stats record');
} catch (error) {
  console.log(JSON.stringify({ ok: false, detail: error.message }));
  process.exit(1);
}
const ok = route.mode === 'writer';
console.log(JSON.stringify(ok ? { ok, authority: route } : { ok, detail: `stats route mode is ${JSON.stringify(route.mode ?? null)}, not writer`, authority: route }));
if (!ok) process.exitCode = 1;
