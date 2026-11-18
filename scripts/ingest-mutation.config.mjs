export default {
  mutate: [
    "cloudflare/src/ingest/ack.ts:19-32",
    "cloudflare/src/core/installation/installation.ts:629-635",
  ],
  testRunner: "command",
  commandRunner: {
    command: "cd cloudflare && node scripts/run-tests.mjs --file test/ingest.test.ts --jobs 1",
  },
  coverageAnalysis: "off",
  reporters: ["clear-text", "json"],
  jsonReporter: { fileName: ".work/tmp/ingest-mutation-worker.json" },
  inPlace: true,
  tempDirName: ".work/tmp/ingest-mutation-worker",
  concurrency: 1,
  timeoutMS: 10000,
};
