import argparse
import collections
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, "/opt/openorange/lib")
import oolib

parser = argparse.ArgumentParser(description="Read-only Stats production resource sampler; run as root on Lisa")
parser.add_argument("--output", required=True)
parser.add_argument("--samples", type=int, default=1441)
parser.add_argument("--interval", type=int, default=60)
args = parser.parse_args()
if not 1 <= args.samples <= 1441 or not 1 <= args.interval <= 300:
    parser.error("invalid sample count or interval")
os.umask(0o077)
cfg = oolib.load()
app = cfg.apps["stats"]
expected = oolib.read_app_deployment(cfg.app_image_file(app))
gateway = oolib.read_env(cfg.app_env(app))["GATEWAY_SECRET"]
engine = oolib.read_env(cfg.engine_env)["RIVET__AUTH__ADMIN_TOKEN"]
stop = threading.Event()
for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
    signal.signal(signum, lambda *_: stop.set())
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def get(origin, path, headers=None):
    request = urllib.request.Request(origin + path, headers=headers or {})
    with opener.open(request, timeout=10) as response:
        raw = response.read(2 * 1024 * 1024 + 1)
        if len(raw) > 2 * 1024 * 1024:
            raise ValueError("oversized response")
        return json.loads(raw)


def command(*words):
    return subprocess.check_output(words, text=True, timeout=15, stderr=subprocess.DEVNULL)


def resources():
    state = json.loads(command("docker", "inspect", app.container, "--format", "{{json .State}}"))
    if not state["Running"]:
        raise ValueError("application stopped")
    pids = [int(line.strip()) for line in command("docker", "top", app.container, "-eo", "pid").splitlines()[1:]]
    rss = 0
    for pid in pids:
        try:
            match = re.search(r"^VmRSS:\s+(\d+) kB$", Path(f"/proc/{pid}/status").read_text(), re.M)
            if match:
                rss += int(match[1]) * 1024
        except FileNotFoundError:
            pass
    return {"rssBytes": rss, "processes": len(pids), "startedAt": state["StartedAt"], "oomKilled": state["OOMKilled"]}


def actors():
    headers = {"Authorization": "Bearer " + engine}
    query = urllib.parse.urlencode({"namespace": app.namespace})
    names = get(cfg.engine_url, "/actors/names?" + query, headers)["names"]
    if not isinstance(names, dict) or len(names) > 32:
        raise ValueError("unexpected actor names")
    result = {}
    for name in names:
        states = collections.Counter()
        cursor = None
        for page in range(20):
            params = {"namespace": app.namespace, "name": name}
            if cursor is not None:
                params["cursor"] = cursor
            body = get(cfg.engine_url, "/actors?" + urllib.parse.urlencode(params), headers)
            for actor in body["actors"]:
                state = "destroyed" if actor.get("destroy_ts") is not None else "sleeping" if actor.get("sleep_ts") is not None else "connectable" if actor.get("connectable_ts") is not None else "pending"
                states[state] += 1
            cursor = body["pagination"]["cursor"]
            if cursor is None:
                break
        result[name] = {"states": dict(states), "truncated": cursor is not None}
    return result


def application():
    body = get(f"http://{app.ip}:{app.port}", "/api/observe/stats/health", {"Stats-Gateway-Secret": gateway, "Stats-Tailnet-Identity": "user:soak@example.invalid"})
    return {key: body[key] for key in ("databaseBytes", "cleanupBacklog", "cleanupLagMs", "liveInvocations", "writes", "rejected", "duplicate", "conflict") if key in body}


def bridge():
    platform = cfg.platform_bridge
    if platform is None:
        return None
    body = get(f"http://{platform.ip}:{platform.port}", "/health")
    return {"producer": {key: body["producer"][key] for key in ("queued", "dropped", "sent", "duplicates", "batches", "retries")}, "received": body["received"], "admitted": body["admitted"], "invalid": body["invalid"]}


started = time.monotonic()
with open(args.output, "x", encoding="utf-8") as output:
    def emit(record):
        output.write(json.dumps(record, separators=(",", ":")) + "\n")
        output.flush()
        os.fsync(output.fileno())

    emit({"kind": "start", "atMs": time.time_ns() // 1_000_000, "image": expected.image, "version": expected.version, "samples": args.samples, "intervalSeconds": args.interval, "traffic": "existing production traffic; no synthetic ingestion", "qualification": "collection only; P8 requires analysis and queue coverage", "gaps": ["runtime inbox depth unavailable", "application producer queues visible only through delivered observations"], "samplerPid": os.getpid()})
    completed = 0
    degraded = 0
    for index in range(args.samples):
        if stop.wait(max(0, started + index * args.interval - time.monotonic())):
            break
        elapsed = time.monotonic() - started
        record = {"kind": "sample", "index": index, "atMs": time.time_ns() // 1_000_000, "elapsedSeconds": elapsed, "latenessSeconds": max(0, elapsed - index * args.interval)}
        current = oolib.read_app_deployment(cfg.app_image_file(app))
        if current != expected:
            emit({**record, "error": "deployment_changed"})
            break
        for key, collect in (("resources", resources), ("actors", actors), ("application", application), ("bridge", bridge)):
            try:
                record[key] = collect()
            except Exception as error:
                record[key] = {"unavailable": type(error).__name__, **({"httpStatus": error.code} if isinstance(error, urllib.error.HTTPError) else {})}
        emit(record)
        degraded += int(any(isinstance(record[key], dict) and "unavailable" in record[key] for key in ("resources", "actors", "application", "bridge")))
        completed += 1
    emit({"kind": "end", "atMs": time.time_ns() // 1_000_000, "elapsedSeconds": time.monotonic() - started, "completedSamples": completed, "degradedSamples": degraded, "complete": completed == args.samples and not stop.is_set()})
