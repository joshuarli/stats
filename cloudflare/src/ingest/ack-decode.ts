import { MAX_SAMPLES } from "../protocol.ts";
import type { SampleRejection } from "../observe/producer/channel.ts";
import { REJECTION_CODES, type Ack } from "./ack.ts";

const MAX_ACK_BYTES = 512;
const MAGIC = [0x53, 0x54, 0x41, 0x32] as const;
const VERSION = 2;
const U64_MAX = 0xffff_ffff_ffff_ffffn;

export class AckDecodeError extends Error {
  constructor(message: string) {
    super(`invalid acknowledgment: ${message}`);
    this.name = "AckDecodeError";
  }
}

const CODE_NAMES = Object.fromEntries(Object.entries(REJECTION_CODES).map(([name, code]) => [code, name])) as Readonly<Record<number, SampleRejection>>;

class Reader {
  readonly #bytes: Uint8Array;
  offset = 5;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  get done(): boolean {
    return this.offset === this.#bytes.length;
  }

  byte(): number {
    const value = this.#bytes[this.offset];
    if (value === undefined) throw new AckDecodeError("truncated");
    this.offset += 1;
    return value;
  }

  varint(): bigint {
    let value = 0n;
    for (let index = 0; index < 10; index += 1) {
      const byte = this.byte();
      if (index === 9 && byte > 1) throw new AckDecodeError("varint exceeds u64");
      value |= BigInt(byte & 0x7f) << BigInt(7 * index);
      if ((byte & 0x80) === 0) {
        if (byte === 0 && index > 0) throw new AckDecodeError("non-canonical varint");
        return value;
      }
    }
    throw new AckDecodeError("varint is too long");
  }
}

export function decodeAck(bytes: Uint8Array, sent: readonly bigint[]): Ack {
  if (bytes.length > MAX_ACK_BYTES) throw new AckDecodeError("body exceeds its bound");
  if (bytes.length < 5 || MAGIC.some((byte, index) => bytes[index] !== byte)) throw new AckDecodeError("magic");
  if (bytes[4] !== VERSION) throw new AckDecodeError("version");
  const reader = new Reader(bytes);
  const accepted = reader.varint();
  const duplicates = reader.varint();
  const count = reader.varint();
  if (count > BigInt(MAX_SAMPLES)) throw new AckDecodeError("too many rejections");
  const total = accepted + duplicates + count;
  if (total > U64_MAX) throw new AckDecodeError("counts overflow");
  if (total !== BigInt(sent.length)) throw new AckDecodeError("counts do not cover the batch");
  if (accepted === 0n && duplicates === 0n) throw new AckDecodeError("a success acknowledgment delivered nothing");
  const unnamed = new Map<bigint, number>();
  for (const seq of sent) unnamed.set(seq, (unnamed.get(seq) ?? 0) + 1);
  const rejected: { seq: bigint; code: SampleRejection }[] = [];
  for (let index = 0n; index < count; index += 1n) {
    const seq = reader.varint();
    const code = CODE_NAMES[reader.byte()];
    if (code === undefined) throw new AckDecodeError("unknown rejection code");
    const remaining = unnamed.get(seq) ?? 0;
    if (remaining === 0) throw new AckDecodeError("rejection names a sample the batch did not carry");
    unnamed.set(seq, remaining - 1);
    rejected.push({ seq, code });
  }
  if (!reader.done) throw new AckDecodeError("trailing bytes");
  return { accepted: Number(accepted), duplicates: Number(duplicates), rejected };
}
