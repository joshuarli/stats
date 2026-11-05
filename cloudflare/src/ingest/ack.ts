export const ACK_MEDIA_TYPE = "application/vnd.stats.ingest-ack.v2";

import type { SampleRejection } from "../observe/producer/channel.ts";

export const REJECTION_CODES = { invalid_sample: 1, too_old: 2, conflict: 3 } as const satisfies Record<SampleRejection, number>;

export interface Ack {
  readonly accepted: number;
  readonly duplicates: number;
  readonly rejected: readonly { readonly seq: bigint; readonly code: SampleRejection }[];
}

function varint(out: number[], value: bigint): void {
  let rest = value;
  while (rest >= 0x80n) {
    out.push(Number(rest & 0x7fn) | 0x80);
    rest >>= 7n;
  }
  out.push(Number(rest));
}

export function encodeAck(ack: Ack): Uint8Array<ArrayBuffer> {
  const out = [0x53, 0x54, 0x41, 0x32, 0x02];
  varint(out, BigInt(ack.accepted));
  varint(out, BigInt(ack.duplicates));
  varint(out, BigInt(ack.rejected.length));
  for (const rejection of ack.rejected) {
    varint(out, rejection.seq);
    out.push(REJECTION_CODES[rejection.code]);
  }
  return new Uint8Array(out);
}
