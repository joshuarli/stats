import json
import os
import resource
import signal
import subprocess
import sys


def main():
    output, command = sys.argv[1], sys.argv[2:]
    code = subprocess.run(command).returncode
    usage = resource.getrusage(resource.RUSAGE_CHILDREN)
    # ru_maxrss is bytes on macOS and KiB on Linux.
    rss_scale = 1 if sys.platform == "darwin" else 1024
    record = {
        "userCpuMs": round(usage.ru_utime * 1000),
        "systemCpuMs": round(usage.ru_stime * 1000),
        "peakProcessRssBytes": usage.ru_maxrss * rss_scale,
        "blockInputs": usage.ru_inblock,
        "blockOutputs": usage.ru_oublock,
    }
    with open(output, "w") as file:
        json.dump(record, file)
    if code < 0:
        signal.signal(-code, signal.SIG_DFL)
        os.kill(os.getpid(), -code)
    sys.exit(code)


main()
