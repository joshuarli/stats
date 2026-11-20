import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, manifestDigest, treeManifest } from "./manifest.mts";

await test("runtime manifest identity uses sorted ASCII JSON", () => {
  const manifest = { schema: "openorange-runtime-manifest/1", entries: [{ path: "é/😀", size: 2 }], excluded: ["release.json"] };
  assert.equal(canonicalJson(manifest), '{"entries":[{"path":"\\u00e9/\\ud83d\\ude00","size":2}],"excluded":["release.json"],"schema":"openorange-runtime-manifest/1"}');
  assert.equal(manifestDigest(manifest), "2fc8fde5872d56048be0f1028df1bf1eb32bc7a2014b355291fece9fe16bd0ac");
  assert.equal(manifestDigest({ "😀": 1, "": 2 }), "8794e338ae5053daf4d72836a1d7c5cea2c587e11010dbc86646230137dd3ab8");
});

await test("tree manifest matches Stuff's oomanifest.py on a fixed tree", () => {
  const root = mkdtempSync(join(process.env["TMPDIR"] ?? ".work/tmp", "tree-manifest-"));
  try {
    mkdirSync(join(root, "node_modules/a/bin"), { recursive: true });
    mkdirSync(join(root, "empty"));
    writeFileSync(join(root, "node_modules/a/index.js"), "module.exports=1\n", { mode: 0o644 });
    writeFileSync(join(root, "node_modules/a/bin/run"), "#!/bin/sh\n", { mode: 0o755 });
    chmodSync(join(root, "node_modules/a/bin/run"), 0o755);
    symlinkSync("a", join(root, "node_modules/b"));
    writeFileSync(join(root, "release.json"), "{}", { mode: 0o644 });
    writeFileSync(join(root, "package.json"), '{"name":"x"}\n', { mode: 0o644 });
    assert.equal(manifestDigest(treeManifest(root)), "a7172674de54cb4165d7725277a8df27698dc6d98986e4ddef2232cdbfd9e00c");
    writeFileSync(join(root, "release.json"), '{"changed":true}');
    assert.equal(manifestDigest(treeManifest(root)), "a7172674de54cb4165d7725277a8df27698dc6d98986e4ddef2232cdbfd9e00c");
    chmodSync(join(root, "node_modules/a/bin/run"), 0o644);
    assert.notEqual(manifestDigest(treeManifest(root)), "a7172674de54cb4165d7725277a8df27698dc6d98986e4ddef2232cdbfd9e00c");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
