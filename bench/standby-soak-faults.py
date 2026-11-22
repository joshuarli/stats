"""Runs a soak's scheduled private faults against the native Stats standby, then reads back its ledger.

  python3 bench/standby-soak-faults.py --definition DEF.json --output FAULTS.jsonl --started-at-ms MS \
      --ssh-config FILE --rollout PATH --statsctl PATH --credential-file FILE --node PATH --repo DIR

Runs on Threadripper's host beside bench/standby-soak.py. Each fault in the definition starts at
its offset from --started-at-ms (the sampler's start), runs under the shared rollout lease when it
touches the guest, and is followed by synthetic ingest checks 30 s apart until one passes or
recoveryLimitS elapses: the check host is admitted six frames a minute, each check sends up to two,
and the sampler's own check shares the host. Every check's sequence is recorded
so the final ledger readback can prove acknowledged writes survived. Host faults run in their own
cgroups under doas, never inside the production VM's cgroup. One fsynced JSON line per event.
"""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import threading
import time

parser = argparse.ArgumentParser()
for name in ("definition", "output", "ssh-config", "rollout", "statsctl", "credential-file", "node", "repo"):
    parser.add_argument("--" + name, required=True)
parser.add_argument("--started-at-ms", type=int, required=True)
parser.add_argument("--origin", default="https://stats.17166969.xyz")
args = parser.parse_args()
definition = json.loads(Path(args.definition).read_text())
credential = json.loads(Path(args.credential_file).read_text())
stop = threading.Event()
for number in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
    signal.signal(number, lambda *_: stop.set())
os.umask(0o077)
now_ms = lambda: time.time_ns() // 1_000_000

ENGINE_RESTART = ("rc-service stats-infra-collector stop >/dev/null; rc-service native-stats stop >/dev/null; "
                  "docker restart --time 20 live-stats-engine >/dev/null; i=0; until wget -q -T 2 -O /dev/null http://127.0.0.1:6420/health; "
                  "do i=$((i + 1)); [ $i -lt 120 ] || exit 1; sleep 1; done; rc-service native-stats start >/dev/null; rc-service stats-infra-collector start >/dev/null")


def leased(operation, bound, command):
    return subprocess.run([args.rollout, "lease", "run", "--target-kind", "native", "--host", "stats-standby", "--ssh-config", args.ssh_config,
                           "--operation", operation, "--bound-s", str(bound), "--", "sh", "-c", command], capture_output=True, text=True, timeout=bound + 120)


def cgroup(name, settings):
    path = f"/sys/fs/cgroup/{name}"
    subprocess.run(["doas", "-n", "mkdir", "-p", path], check=True)
    for key, value in settings.items():
        subprocess.run(["doas", "-n", "tee", f"{path}/{key}"], input=value + "\n", text=True, capture_output=True, check=True)
    return path


def enter(path, pid):
    subprocess.run(["doas", "-n", "tee", f"{path}/cgroup.procs"], input=f"{pid}\n", text=True, capture_output=True, check=True)


def host_cpu(fault):
    group = cgroup("soak-hogs", {"cpu.weight": "100"})
    hogs = []
    try:
        for _ in range(fault["loops"]):
            process = subprocess.Popen(["sh", "-c", "while :; do :; done"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            enter(group, process.pid)
            hogs.append(process)
        stop.wait(fault["durationS"])
    finally:
        for process in hogs:
            process.kill()
            process.wait()


def host_disk_write(fault):
    device = Path("/sys/block/nvme0n1/dev").read_text().strip()
    group = cgroup("soak-disk", {"io.max": f"{device} wbps={fault['writeBytesPerSecond']}"})
    target = Path.home() / ".cache" / "soak-disk-write.bin"
    process = subprocess.Popen(["sh", "-c", f"sleep 1; dd if=/dev/zero of={target} bs=1M count={fault['bytes'] // 1048576} conv=fsync 2>/dev/null"])
    enter(group, process.pid)
    try:
        process.wait(timeout=fault["bytes"] // fault["writeBytesPerSecond"] + 600)
    finally:
        target.unlink(missing_ok=True)


def run_fault(fault):
    kind = fault["kind"]
    if kind == "app-restart":
        result = leased("soak-app-restart", 300, "rc-service native-stats restart >/dev/null")
    elif kind == "engine-restart":
        result = leased("soak-engine-restart", 300, ENGINE_RESTART)
    elif kind == "depot-warm-read":
        # Reads the whole depot from the disk that holds it while the Engine serves; nothing is
        # written, so the guest's free space is unchanged.
        result = leased("soak-depot-read", fault["boundS"] + 30, f"timeout {fault['boundS']} tar -cf - -C /var/lib/live-stats log objects | cat >/dev/null")
    elif kind == "host-cpu":
        host_cpu(fault)
        return None
    elif kind == "host-disk-write":
        host_disk_write(fault)
        return None
    else:
        raise ValueError(f"unknown fault kind {kind}")
    return None if result.returncode == 0 else f"exit {result.returncode}: {(result.stderr or result.stdout).strip()[-300:]}"


def check():
    result = subprocess.run([args.statsctl, "check", "ingest", "--origin", args.origin, "--credential-file", args.credential_file, "--json"], capture_output=True, text=True, timeout=60)
    try:
        payload = json.loads(result.stdout)["payload"]
        return payload["ok"], payload.get("seq"), [s["name"] for s in payload["steps"] if not s["ok"]]
    except (ValueError, KeyError):
        return False, None, ["unreadable"]


with open(args.output, "x", encoding="utf-8") as output:
    def emit(record):
        output.write(json.dumps(record, separators=(",", ":")) + "\n")
        output.flush()
        os.fsync(output.fileno())

    emit({"kind": "start", "atMs": now_ms(), "startedAtMs": args.started_at_ms, "faults": [f["name"] for f in definition["faults"]]})
    for fault in definition["faults"]:
        due = args.started_at_ms + int(fault["atHours"] * 3_600_000)
        if stop.wait(max(0, (due - now_ms()) / 1000)):
            break
        record = {"kind": "fault", "name": fault["name"], "faultKind": fault["kind"], "startedAtMs": now_ms()}
        try:
            record["error"] = run_fault(fault)
        except Exception as error:
            record["error"] = f"{type(error).__name__}: {error}"
        record["endedAtMs"] = now_ms()
        recovered = None
        while not stop.is_set() and now_ms() - record["endedAtMs"] <= definition["recoveryLimitS"] * 1000:
            ok, seq, failed = check()
            emit({"kind": "recovery-check", "fault": fault["name"], "atMs": now_ms(), "ok": ok, "seq": seq, "failed": failed})
            if ok:
                recovered = round((now_ms() - record["endedAtMs"]) / 1000, 1)
                break
            stop.wait(30)
        record["recoveredAfterS"] = recovered
        emit(record)
    due = args.started_at_ms + int(definition["durationHours"] * 3_600_000) + 300_000
    if not stop.wait(max(0, (due - now_ms()) / 1000)):
        ledger = subprocess.run([args.node, "--experimental-strip-types", f"{args.repo}/bench/standby-soak-ledger.mts", "--origin", args.origin,
                                 "--host-id", credential["hostId"], "--from", str(args.started_at_ms - 60_000), "--to", str(now_ms())],
                                capture_output=True, text=True, timeout=600)
        emit(json.loads(ledger.stdout) if ledger.returncode == 0 else {"kind": "ledger-failed", "exit": ledger.returncode, "stderr": ledger.stderr[-500:]})
    emit({"kind": "end", "atMs": now_ms(), "interrupted": stop.is_set()})
