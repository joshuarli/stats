#!/bin/sh
set -eu
[ "$#" -ge 11 ] || { echo 'usage: install.sh launchd|openrc TEMPLATE OUTPUT NODE SCRIPT STATE CANDIDATE STATSCTL HOSTS HEALTH INTERVAL [--http NAME=URL,...] [--tcp NAME=HOST:PORT,...] [--content-file PATH] [--content-interval-s SECONDS]' >&2; exit 2; }
kind=$1; template=$2; output=$3; node=$4; script=$5; state=$6; candidate=$7; statsctl=$8; hosts=$9; shift 9; health=$1; interval=$2; shift 2
"$node" - "$kind" "$template" "$output" "$node" "$script" "$state" "$candidate" "$statsctl" "$hosts" "$health" "$interval" "$@" <<'JS'
const fs = require('node:fs');
const [kind, template, output, ...all] = process.argv.slice(2);
const args = all.slice(0, 8), extra = all.slice(8);
if (extra.length % 2 !== 0 || extra.some((value, index) => index % 2 === 0 && !['--http', '--tcp', '--content-file', '--content-interval-s'].includes(value))) throw new Error('optional checks are --http, --tcp, --content-file and --content-interval-s pairs');
if (!['launchd', 'openrc'].includes(kind)) throw new Error('unknown service type');
const text = fs.readFileSync(template, 'utf8');
const escape = value => kind === 'launchd' ? value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;') : "'" + value.replaceAll("'", "'\\''") + "'";
const values = [args[0], args[1], '--state-dir', args[2], '--candidate-dir', args[3], '--statsctl', args[4], '--hosts', args[5], '--health', args[6], '--interval-s', args[7], ...extra];
const rendered = kind === 'launchd' ? values.map(value => `    <string>${escape(value)}</string>`).join('\n') : `command=${escape(values[0])}\ncommand_args=${escape(values.slice(1).map(escape).join(' '))}`;
fs.writeFileSync(output, text.replace('@COMMAND@', rendered), { mode: 0o755, flag: 'wx' });
JS
