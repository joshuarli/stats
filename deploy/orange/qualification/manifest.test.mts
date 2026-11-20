import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalJson, manifestDigest } from "./manifest.mts";

await test("runtime manifest identity uses sorted ASCII JSON", () => {
  const manifest = { schema: "openorange-runtime-manifest/1", entries: [{ path: "é/😀", size: 2 }], excluded: ["release.json"] };
  assert.equal(canonicalJson(manifest), '{"entries":[{"path":"\\u00e9/\\ud83d\\ude00","size":2}],"excluded":["release.json"],"schema":"openorange-runtime-manifest/1"}');
  assert.equal(manifestDigest(manifest), "2fc8fde5872d56048be0f1028df1bf1eb32bc7a2014b355291fece9fe16bd0ac");
  assert.equal(manifestDigest({ "😀": 1, "": 2 }), "8794e338ae5053daf4d72836a1d7c5cea2c587e11010dbc86646230137dd3ab8");
});
