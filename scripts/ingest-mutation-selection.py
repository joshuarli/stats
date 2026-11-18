from pathlib import PurePosixPath
import re
import subprocess
import sys


def git(*args):
    return subprocess.check_output(["git", *args], text=True)


def restrict(path, before, after, ranges):
    old = before.splitlines(keepends=True)
    new = after.splitlines(keepends=True)
    for first, last in reversed(ranges):
        del old[first - 1:last]
        del new[first - 1:last]
    if old != new:
        raise ValueError(f"change outside the qualified source ranges: {path}")


def select(base, lane):
    if lane not in {"rust", "worker"}:
        raise ValueError(f"unknown ingest mutation lane: {lane}")
    if git("status", "--porcelain", "--untracked-files=normal"):
        raise ValueError("commit the selected changes before running ingest mutations")
    root = git("merge-base", "--", base, "HEAD").strip()
    changed = git("diff", "--name-status", "--no-renames", "-z", root, "HEAD").split("\0")
    tests = (
        "cloudflare/test/ingest", "agent/tests/", "fixtures/v2/",
    )
    settings = {
        "Makefile", "agent/Cargo.lock", "agent/Cargo.toml", "rust-toolchain.toml",
        "cloudflare/package.json", "cloudflare/vitest.config.mjs", "cloudflare/wrangler.test.jsonc",
        "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc", ".gitignore",
        ".github/workflows/ingest-mutation-trial.yml", ".github/workflows/ci.yml",
        "scripts/ingest-mutation-selection.py", "scripts/ingest-mutation.config.mjs",
        "scripts/check-ingest-mutations.mjs", "scripts/run-ingest-mutation.sh",
    }
    protected = set()
    if changed[-1] or len(changed) % 2 == 0:
        raise ValueError("malformed Git change list")
    for status, path in zip(changed[0:-1:2], changed[1:-1:2]):
        if path in settings or path.startswith(tests):
            print(f"protected by tests or settings: {path}")
            protected.update(("rust", "worker"))
        elif PurePosixPath(path).suffix == ".md" or path == "LICENSE":
            print(f"documentation: {path}")
        elif path == "cloudflare/src/ingest/ack.ts":
            restrict(path, git("show", f"{root}:{path}"), git("show", f"HEAD:{path}"), [(19, 32)])
            print(f"Worker ACK encoder: {path}")
            protected.add("worker")
        elif path == "cloudflare/src/core/installation/installation.ts":
            restrict(path, git("show", f"{root}:{path}"), git("show", f"HEAD:{path}"), [(629, 635)])
            print(f"Worker response emission: {path}")
            protected.add("worker")
        elif path == "agent/src/wire.rs" and status == "M":
            before = git("show", f"{root}:{path}")
            after = git("show", f"HEAD:{path}")
            module = re.compile(r"(?m)^#\[cfg\(test\)\]\nmod tests \{")
            old_tests, new_tests = module.search(before), module.search(after)
            if old_tests is None or new_tests is None or before[:old_tests.start()] != after[:new_tests.start()]:
                raise ValueError(f"wire production edits need a qualified changed-region selection: {path}")
            print(f"wire test module: {path}")
            protected.update(("rust", "worker"))
        else:
            raise ValueError(f"outside the qualified ingest scope: {path}")
    if not protected:
        print("irrelevant change: no mutations selected")
    return lane in protected


if __name__ == "__main__":
    try:
        selected = select(*sys.argv[1:])
        print(f"selected={str(selected).lower()}")
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
