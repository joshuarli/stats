"""Samples the native Stats standby writer for a sustained-operation soak.

Runs on Threadripper's host, outside the guest it observes, with the SSH alias stats-standby from
--ssh-config. Each sample runs one read-only probe on the guest (loaded identities and process
start times, RSS and cumulative CPU, disk and Engine storage gauges, Engine warning classes since
the previous sample, actor counts, application health) and, every --check-every samples, one
synthetic ingest with readback and duplicate replay through ordinary public ingress. Every record
is one fsynced JSON line in --output. Secrets are read on the guest and never leave it; the
synthetic credential stays in its file. bench/analyze-standby-soak.py judges the result.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import threading
import time

GUEST_PROBE = r'''
import json, os, re, subprocess, time, urllib.request
def run(*a):
    return subprocess.run(a, capture_output=True, text=True, timeout=20).stdout
def env(path, key):
    for line in open(path):
        if line.startswith(key + "="):
            return line.split("=", 1)[1].strip()
def get(url, headers):
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=10) as r:
        return json.loads(r.read(4 * 1024 * 1024))
def tree(path):
    total = 0
    for root, _, files in os.walk(path):
        for f in files:
            try: total += os.lstat(os.path.join(root, f)).st_size
            except FileNotFoundError: pass
    return total
since = int(os.environ["SINCE_S"])
out = {"atMs": int(time.time() * 1000)}
opt = "/opt/native-rehearsal"
out["identity"] = {"app": os.path.basename(os.path.realpath(opt + "/app/current")), "runtime": os.path.basename(os.path.realpath(opt + "/orange"))}
inspect = json.loads(run("docker", "inspect", "live-stats-engine"))[0]
out["identity"]["engineImage"] = inspect["Image"]
out["identity"]["engineStartedAt"] = inspect["State"]["StartedAt"]
out["identity"]["engineRestartCount"] = inspect["RestartCount"]
out["identity"]["engineOomKilled"] = inspect["State"]["OOMKilled"]
out["identity"]["engineConfigSha256"] = __import__("hashlib").sha256(open(opt + "/live-engine.json", "rb").read()).hexdigest()
hz = os.sysconf("SC_CLK_TCK")
users = {"native-stats": [], "stats-infra": []}
uids = {}
for line in open("/etc/passwd"):
    p = line.split(":")
    if p[0] in users: uids[int(p[2])] = p[0]
for pid in os.listdir("/proc"):
    if not pid.isdigit(): continue
    try:
        st = os.stat("/proc/" + pid)
        if st.st_uid not in uids: continue
        stat = open("/proc/%s/stat" % pid).read().rsplit(")", 1)[1].split()
        rss = int(re.search(r"^VmRSS:\s+(\d+) kB", open("/proc/%s/status" % pid).read(), re.M).group(1)) * 1024
        users[uids[st.st_uid]].append({"pid": int(pid), "start": int(stat[19]), "cpuTicks": int(stat[11]) + int(stat[12]), "rss": rss})
    except (FileNotFoundError, ProcessLookupError, AttributeError):
        pass
for name, procs in users.items():
    key = "app" if name == "native-stats" else "collector"
    out[key] = {"processes": len(procs), "rssBytes": sum(p["rss"] for p in procs), "cpuSeconds": sum(p["cpuTicks"] for p in procs) / hz,
                "oldestStart": min((p["start"] for p in procs), default=None), "pids": sorted(p["pid"] for p in procs)}
cg = "/sys/fs/cgroup/docker/" + inspect["Id"]
cpu = dict(l.split() for l in open(cg + "/cpu.stat"))
mem = dict(l.split() for l in open(cg + "/memory.stat"))
out["engine"] = {"memoryBytes": int(open(cg + "/memory.current").read()), "anonBytes": int(mem["anon"]), "fileBytes": int(mem["file"]), "cpuSeconds": int(cpu["usage_usec"]) / 1e6,
                 "throttledSeconds": int(cpu.get("throttled_usec", 0)) / 1e6}
vfs = os.statvfs("/")
out["disk"] = {"freeBytes": vfs.f_bavail * vfs.f_frsize, "logShardsBytes": tree("/var/lib/live-stats/log/shards"),
               "coldCacheBytes": tree("/var/lib/live-stats/log/cold-cache"), "objectsBytes": tree("/var/lib/live-stats/objects")}
gauges = {}
wanted = re.compile(r"^(rivet_depot_(alarm_(operations|candidates|parked|callbacks)|tablet_store_queue_depth|tablet_store_in_flight|cold_store_unflushed_bytes|cold_store_disk_cache_usage\{unit=\"bytes\"\}|disk_capacity_bytes\S*|volume_log_client_queued_requests|tablet_group_reads_queued|tablet_volume_refusals_total|lease_degraded_refusals_total|volume_client_shard_refused_writes_total|cold_store_disk_cache_evicted_total\{unit=\"bytes\"\}))")
try:
    for line in urllib.request.urlopen("http://127.0.0.1:6430/metrics", timeout=10).read().decode().splitlines():
        m = wanted.match(line)
        if m:
            name, value = line.rsplit(" ", 1)
            family = re.sub(r"\{.*", "", name) if "{" in name and "unit=" not in name else name
            gauges[family] = gauges.get(family, 0) + float(value)
    out["engineMetrics"] = gauges
except Exception as error:
    out["engineMetrics"] = {"unavailable": type(error).__name__}
logs = subprocess.run(["docker", "logs", "--since", "%ds" % since, "live-stats-engine"], capture_output=True, text=True, timeout=30)
text = logs.stdout + logs.stderr
classes = {"refusedConnect": "refusing envoy connect", "deadline": "request_deadline_exceeded", "alarmFailed": "alarm callback failed",
           "commandCapacity": "command_capacity", "nearCapacity": "near its capacity", "coldReadsNear": "cold reads near",
           "replicaLogWindow": "replica log read window", "envoyClosed": "Envoy connection closed", "unstructured": "unstructured error"}
out["warnings"] = {"total": text.count("level=warn"), "errors": text.count("level=error"), **{k: text.count(v) for k, v in classes.items()}}
conf = "/etc/conf.d/native-stats"
try:
    out["application"] = get("http://127.0.0.1:8080/api/observe/stats/health", {"Stats-Gateway-Secret": env(conf, "GATEWAY_SECRET"), "Stats-Tailnet-Identity": "user:soak@example.invalid"})
except Exception as error:
    out["application"] = {"unavailable": type(error).__name__}
try:
    headers = {"Authorization": "Bearer " + env(conf, "RIVET_TOKEN")}
    actors = {}
    for name in get("http://127.0.0.1:6420/actors/names?namespace=stats-prod", headers)["names"]:
        counts, cursor = {}, None
        for _ in range(20):
            query = "namespace=stats-prod&name=" + name + ("&cursor=" + cursor if cursor else "")
            body = get("http://127.0.0.1:6420/actors?" + query, headers)
            for actor in body["actors"]:
                state = "destroyed" if actor.get("destroy_ts") else "sleeping" if actor.get("sleep_ts") else "connectable" if actor.get("connectable_ts") else "pending"
                counts[state] = counts.get(state, 0) + 1
            cursor = body["pagination"]["cursor"]
            if cursor is None: break
        actors[name] = {"states": counts, "truncated": cursor is not None}
    out["actors"] = actors
except Exception as error:
    out["actors"] = {"unavailable": type(error).__name__}
sources_to = int(os.environ.get("SOURCES_TO_MS", "0"))
if sources_to:
    try:
        headers = {"Stats-Gateway-Secret": env(conf, "GATEWAY_SECRET"), "Stats-Tailnet-Identity": "user:soak@example.invalid"}
        out["sources"] = {"fromMs": sources_to - 3600000, "toMs": sources_to, **{release: get("http://127.0.0.1:8080/api/observe/stats-infra/metrics/sources?from=%d&to=%d&release=%s" % (sources_to - 3600000, sources_to, release), headers)["sources"] for release in ("runtime", "app")}}
        for release in ("runtime", "app"):
            for row in out["sources"][release]:
                row["detail"].pop("values", None)
    except Exception as error:
        out["sources"] = {"unavailable": type(error).__name__}
print(json.dumps(out, separators=(",", ":")))
'''

parser = argparse.ArgumentParser(description="Sustained-operation soak sampler for the native Stats standby; run on Threadripper's host")
parser.add_argument("--output", required=True)
parser.add_argument("--ssh-config", required=True)
parser.add_argument("--statsctl", required=True)
parser.add_argument("--credential-file", required=True)
parser.add_argument("--origin", default="https://stats.17166969.xyz")
parser.add_argument("--samples", type=int, default=1441)
parser.add_argument("--interval", type=int, default=60)
parser.add_argument("--check-every", type=int, default=5)
parser.add_argument("--definition", required=True, help="the frozen soak definition; its SHA-256 is bound into the start record")
args = parser.parse_args()
if not 1 <= args.samples <= 2881 or not 10 <= args.interval <= 300 or args.check_every < 1:
    parser.error("invalid sample count, interval or check cadence")
os.umask(0o077)
stop = threading.Event()
for number in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
    signal.signal(number, lambda *_: stop.set())


def probe(since, sources_to_ms=0):
    result = subprocess.run(["ssh", "-F", args.ssh_config, "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "stats-standby",
                             f"SINCE_S={since} SOURCES_TO_MS={sources_to_ms} python3 -I -"], input=GUEST_PROBE, capture_output=True, text=True, timeout=45)
    if result.returncode != 0:
        raise RuntimeError(f"probe exited {result.returncode}: {result.stderr.strip()[:200]}")
    return json.loads(result.stdout)


def check():
    started = time.monotonic()
    result = subprocess.run([args.statsctl, "check", "ingest", "--origin", args.origin, "--credential-file", args.credential_file, "--json"],
                            capture_output=True, text=True, timeout=60)
    try:
        payload = json.loads(result.stdout)["payload"]
    except (ValueError, KeyError):
        return {"ok": False, "exit": result.returncode, "wallMs": round((time.monotonic() - started) * 1000), "steps": None}
    return {"ok": payload["ok"], "seq": payload.get("seq"), "hostId": payload.get("hostId"), "wallMs": round((time.monotonic() - started) * 1000),
            "steps": [{"name": s["name"], "ok": s["ok"], "ms": s["ms"], "code": s.get("code")} for s in payload["steps"]]}


started = time.monotonic()
with open(args.output, "x", encoding="utf-8") as output:
    def emit(record):
        output.write(json.dumps(record, separators=(",", ":")) + "\n")
        output.flush()
        os.fsync(output.fileno())

    first = probe(args.interval)
    emit({"kind": "start", "atMs": time.time_ns() // 1_000_000, "identity": first["identity"], "samples": args.samples, "intervalSeconds": args.interval,
          "checkEvery": args.check_every, "origin": args.origin, "scriptSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
          "definitionSha256": hashlib.sha256(Path(args.definition).read_bytes()).hexdigest(), "samplerPid": os.getpid(),
          "traffic": "existing production traffic plus the synthetic check", "gaps": ["runtime inbox depth unavailable", "native export-loss counters unavailable",
          "actor lifecycle timestamps do not establish state", "application producer queues visible only through delivered observations"]})
    completed = degraded = 0
    for index in range(args.samples):
        if stop.wait(max(0, started + index * args.interval - time.monotonic())):
            break
        elapsed = time.monotonic() - started
        record = {"kind": "sample", "index": index, "atMs": time.time_ns() // 1_000_000, "elapsedSeconds": round(elapsed, 3),
                  "latenessSeconds": round(max(0, elapsed - index * args.interval), 3)}
        try:
            # Source evidence needs a collector delivery after the window ends, so each hourly export
            # covers the hour that closed two minutes ago; it is frozen here before metric retention
            # ends. The first export covers the soak's first hour, not the hour before it.
            record["guest"] = probe(args.interval, record["atMs"] - 120_000 if index and index % 60 == 0 else 0)
        except Exception as error:
            record["guest"] = {"unavailable": type(error).__name__, "detail": str(error)[:200]}
        if index % args.check_every == 0:
            try:
                record["check"] = check()
            except Exception as error:
                record["check"] = {"ok": False, "unavailable": type(error).__name__}
        emit(record)
        guest = record["guest"]
        degraded += int("unavailable" in guest or any(isinstance(guest.get(k), dict) and "unavailable" in guest[k] for k in ("application", "actors", "engineMetrics", "sources")))
        completed += 1
    emit({"kind": "end", "atMs": time.time_ns() // 1_000_000, "elapsedSeconds": time.monotonic() - started, "completedSamples": completed,
          "degradedSamples": degraded, "complete": completed == args.samples and not stop.is_set()})
