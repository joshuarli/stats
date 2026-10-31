import { build } from "esbuild";
import { copyFile, readFile, stat } from "node:fs/promises";

await build({
  entryPoints: ["src/client/app.ts"],
  bundle: true,
  format: "esm",
  target: "es2022",
  outfile: "public/app.js",
  minify: true,
  legalComments: "none",
  sourcemap: false
});
await copyFile("src/client/style.css", "public/app.css");
const script = await readFile("public/app.js");
const style = await readFile("public/app.css");
const html = await readFile("public/index.html");
const forbidden = [/nft_[A-Za-z0-9_-]{43}/u, /ACCESS_JWKS_JSON/u, /BEGIN (RSA )?PRIVATE KEY/u, /test-only/u];
for (const pattern of forbidden) {
  if (pattern.test(script.toString()) || pattern.test(html.toString())) {
    console.error(`public assets contain a forbidden pattern: ${pattern}`);
    process.exit(1);
  }
}
if (script.length > 120_000) {
  console.error(`public/app.js is ${script.length} bytes, over the 120000 byte cap`);
  process.exit(1);
}
const scripts = html.toString().match(/<script\b/gu)?.length ?? 0;
if (scripts !== 1) {
  console.error(`public/index.html must have exactly one script entrypoint, found ${scripts}`);
  process.exit(1);
}
const scriptSize = (await stat("public/app.js")).size;
const styleSize = (await stat("public/app.css")).size;
console.log(`public assets: ${scriptSize} bytes JS, ${styleSize} bytes CSS`);
