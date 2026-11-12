import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "../../..");
for (const os of ["Linux", "Darwin"]) {
  for (const failure of ["download", "missing", "duplicate", "malformed", "verifier", "mismatch", "none"]) {
    await test(`installer on ${os}: ${failure}`, () => {
      const scratch = mkdtempSync(join(root, ".work/tmp/installer-"));
      try {
        const bin = join(scratch, "bin");
        mkdirSync(bin);
        const stub = (name: string, body: string) => {
          writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
          chmodSync(join(bin, name), 0o755);
        };
        for (const name of ["sed", "awk", "cut", "mktemp", "rm", "chmod", "mkdir"]) symlinkSync(existsSync(`/usr/bin/${name}`) ? `/usr/bin/${name}` : `/bin/${name}`, join(bin, name));
        stub("uname", `case "$1" in -s) echo ${os};; -m) echo arm64;; esac`);
        stub("id", "echo 0");
        stub("install", `echo installed > '${scratch}/installed'; exit 99`);
        const digest = createHash("sha256").update("binary").digest("hex");
        const asset = `stats-1.0.0-aarch64-${os === "Linux" ? "unknown-linux-musl" : "apple-darwin"}`;
        const manifest = failure === "missing" ? `${digest} other` : failure === "malformed" ? `bad ${asset}` : failure === "mismatch" ? `${"0".repeat(64)} ${asset}` : `${digest} ${asset}${failure === "duplicate" ? `\n${digest} ${asset}` : ""}`;
        writeFileSync(join(scratch, "manifest"), manifest);
        stub("curl", `case "$4" in *SHA256SUMS) ${failure === "download" ? "exit 22" : `/bin/cat '${scratch}/manifest' > "$3"`};; *) printf binary > "$3";; esac`);
        if (failure !== "verifier") symlinkSync("/usr/bin/shasum", join(bin, "shasum"));
        const result = spawnSync("/bin/sh", [join(root, "install.sh")], { env: { ...process.env, PATH: bin, TMPDIR: scratch, STATS_VERSION: "v1.0.0", STATS_INSTALL_DIR: join(scratch, "install"), STATS_CONFIG_DIR: join(scratch, "config") }, encoding: "utf8" });
        assert.equal(existsSync(join(scratch, "installed")), failure === "none", result.stdout + result.stderr);
        assert.equal(result.status, failure === "none" ? 99 : failure === "download" ? 22 : 1, result.stderr);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    });
  }
}
