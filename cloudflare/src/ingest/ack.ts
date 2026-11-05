export const ACK_MEDIA_TYPE = "application/vnd.stats.ingest-ack.v2";

import { SAMPLE_REJECTIONS, type SampleRejection } from "../observe/producer/channel.ts";

export { SAMPLE_REJECTIONS, type SampleRejection };

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
    out.push(SAMPLE_REJECTIONS[rejection.code]);
  }
  return new Uint8Array(out);
}
