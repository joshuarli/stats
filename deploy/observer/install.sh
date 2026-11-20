#!/bin/sh
set -eu
[ "$#" -eq 12 ] || { echo 'usage: install.sh launchd|openrc TEMPLATE OUTPUT NODE SCRIPT STATE CANDIDATE STATSCTL HOSTS HEALTH CREDENTIAL INTERVAL' >&2; exit 2; }
kind=$1; template=$2; output=$3; node=$4; script=$5; state=$6; candidate=$7; statsctl=$8; hosts=$9; shift 9; health=$1; credential=$2; interval=$3
"$node" - "$kind" "$template" "$output" "$node" "$script" "$state" "$candidate" "$statsctl" "$hosts" "$health" "$credential" "$interval" <<'JS'
const fs = require('node:fs');
const [kind, template, output, ...args] = process.argv.slice(2);
if (!['launchd', 'openrc'].includes(kind)) throw new Error('unknown service type');
const text = fs.readFileSync(template, 'utf8');
const escape = value => kind === 'launchd' ? value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;') : "'" + value.replaceAll("'", "'\\''") + "'";
const values = [args[0], args[1], '--state-dir', args[2], '--candidate-dir', args[3], '--statsctl', args[4], '--hosts', args[5], '--health', args[6], '--credential-file', args[7], '--interval-s', args[8]];
const rendered = kind === 'launchd' ? values.map(value => `    <string>${escape(value)}</string>`).join('\n') : `command=${escape(values[0])}\ncommand_args=${escape(values.slice(1).map(escape).join(' '))}`;
fs.writeFileSync(output, text.replace('@COMMAND@', rendered), { mode: 0o755, flag: 'wx' });
JS
