import { main } from "./run.ts";

const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());

process.exitCode = await main(process.argv.slice(2), {
  env: process.env,
  signal: controller.signal,
  io: {
    stdout: text => void process.stdout.write(text),
    stderr: text => void process.stderr.write(text),
    isTty: process.stdout.isTTY === true
  }
});
