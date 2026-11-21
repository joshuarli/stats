#!/bin/sh
# Boots a copy of the standby guest with no outbound network inside its own CPU set,
# then adds or removes busy loops on that set to reproduce host CPU contention.
# Run on Threadripper as the owner of DRILL_DIR; cgroup writes use doas.
set -eu

usage() {
	cat <<'EOF'
usage: contention-drill.sh start|hogs N|unhog|status|stop

  start    boot DRILL_DIR/clone.qcow2 (restricted user networking, ssh on DRILL_SSH_PORT,
           guest 8080 on DRILL_APP_PORT) in cgroup drill-vm with cpu.weight 100 on DRILL_CPUS
  hogs N   start N busy loops in cgroup drill-hogs on the same CPUs (default weight 100)
  unhog    kill every busy loop in drill-hogs
  status   print load, both cgroups' CPU use and the guest's process count
  stop     power the guest off through ssh, then kill qemu if it is still running

environment: DRILL_DIR (default ~/.local/share/sta135), DRILL_CPUS (default 12-15,28-31),
DRILL_SSH_PORT (default 49277), DRILL_APP_PORT (default 49280), DRILL_KEY (guest root key; without it stop kills qemu)
EOF
}

dir=${DRILL_DIR:-$HOME/.local/share/sta135}
cpus=${DRILL_CPUS:-12-15,28-31}
ssh_port=${DRILL_SSH_PORT:-49277}
app_port=${DRILL_APP_PORT:-49280}
vm=/sys/fs/cgroup/drill-vm
hogs=/sys/fs/cgroup/drill-hogs

group() {
	doas -n mkdir -p "$1"
	printf '%s\n' "$cpus" | doas -n tee "$1/cpuset.cpus" >/dev/null
	printf '100\n' | doas -n tee "$1/cpu.weight" >/dev/null
}

guest() {
	[ -n "${DRILL_KEY:-}" ] || return 1
	ssh -F /dev/null -o BatchMode=yes -o ConnectTimeout=5 -o IdentitiesOnly=yes -o StrictHostKeyChecking=no \
		-o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -i "$DRILL_KEY" -p "$ssh_port" root@127.0.0.1 "$@"
}

case "${1:-}" in
start)
	group "$vm"
	cd "$dir"
	qemu-system-x86_64 -enable-kvm -cpu host -smp 8 -m 4096 \
		-drive file=clone.qcow2,format=qcow2,if=virtio -cdrom seed.iso \
		-nic "user,model=virtio-net-pci,restrict=on,hostfwd=tcp:127.0.0.1:$ssh_port-:22,hostfwd=tcp:127.0.0.1:$app_port-:8080" \
		-display none -serial file:console.log -monitor none -pidfile qemu.pid -daemonize
	read -r pid < qemu.pid
	printf '%s\n' "$pid" | doas -n tee "$vm/cgroup.procs" >/dev/null
	echo "drill guest pid $pid in $vm on CPUs $cpus"
	;;
hogs)
	n=${2:?hogs needs a count}
	group "$hogs"
	i=0
	while [ "$i" -lt "$n" ]; do
		sh -c 'while :; do :; done' </dev/null >/dev/null 2>&1 &
		printf '%s\n' "$!" | doas -n tee "$hogs/cgroup.procs" >/dev/null
		i=$((i + 1))
	done
	echo "$n busy loops in $hogs"
	;;
unhog)
	[ -d "$hogs" ] && doas -n sh -c "cat $hogs/cgroup.procs | xargs -r kill" || true
	echo "busy loops stopped"
	;;
status)
	cut -d' ' -f1-3 /proc/loadavg
	for g in "$vm" "$hogs"; do
		[ -d "$g" ] && echo "$g $(grep usage_usec "$g/cpu.stat") procs=$(wc -l < "$g/cgroup.procs")"
	done
	;;
stop)
	guest poweroff || true
	i=0
	while [ -r "$dir/qemu.pid" ] && kill -0 "$(cat "$dir/qemu.pid")" 2>/dev/null && [ "$i" -lt 60 ]; do sleep 1; i=$((i + 1)); done
	[ -r "$dir/qemu.pid" ] && kill "$(cat "$dir/qemu.pid")" 2>/dev/null || true
	"$0" unhog
	;;
-h|--help) usage ;;
*) usage >&2; exit 2 ;;
esac
