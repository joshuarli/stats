import { encodeEvent } from "../packages/producer/src/protocol.ts";

const count = Number(process.argv[2] ?? "256");
if (!Number.isSafeInteger(count) || count < 1) throw new TypeError("queue count must be a positive integer");

const work = Object.fromEntries(Array.from({ length: 16 }, (_, index) => [
  `k${String(index).padStart(2, "0")}${"a".repeat(27)}`,
  1_000_000_000_000
]));
const event = {
  schemaVersion: 1 as const,
  eventId: "E".repeat(64),
  atMs: 8_640_000_000_000_000,
  operation: "o".repeat(64),
  outcome: "u".repeat(32),
  durationMs: 86_400_000,
  work,
  release: "r".repeat(64),
  service: "s".repeat(32),
  instance: "i".repeat(128),
  host: "h".repeat(128),
  trace: { traceId: `${"0".repeat(31)}1`, spanId: `${"0".repeat(15)}1` }
};
const eventBytes = new TextEncoder().encode(encodeEvent(event)).byteLength;
process.stdout.write(`${JSON.stringify({ count, eventBytes, queueBytes: eventBytes * count, mib: eventBytes * count / 1_048_576 })}\n`);
