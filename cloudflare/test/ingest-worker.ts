import { env, SELF } from "cloudflare:test";
import { encodeFrame, type SourceBatch } from "./support/stb2.ts";

const files: Record<string, string> = JSON.parse(env.FIXTURES ?? "{}");

export const INGEST_URL = "https://example.com/ingest/v2/batches";
export const INGEST_TYPE = "application/vnd.stats.ingest.v2";
export const ACK_TYPE = "application/vnd.stats.ingest-ack.v2";

export function fixtureText(relative: string): string {
  const text = files[relative];
  if (text === undefined) throw new Error(`${relative} is not a fixture`);
  return text;
}

export function fixtureBytes(relative: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(fixtureText(relative)), character => character.charCodeAt(0));
}

export function source(name: string): SourceBatch {
  return JSON.parse(fixtureText(`sources/${name}.json`)) as SourceBatch;
}

export function frameFor(name: string, hostId: string, options: { readonly delta?: boolean } = {}): Uint8Array<ArrayBuffer> {
  return encodeFrame({ ...source(name), hostId }, options);
}

export function frame(batch: SourceBatch): Uint8Array<ArrayBuffer> {
  return encodeFrame(batch);
}

export async function post(token: string | null, body: BodyInit, headers: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch(INGEST_URL, { method: "POST", headers: { ...(token === null ? {} : { Authorization: `Bearer ${token}` }), "Content-Type": INGEST_TYPE, ...headers }, body });
}

export interface DecodedAck { readonly accepted: number; readonly duplicates: number; readonly rejected: readonly { readonly seq: string; readonly code: "invalid_sample" | "too_old" | "conflict" }[] }

export async function readAck(response: Response): Promise<DecodedAck> {
  if (response.status !== 200 || response.headers.get("content-type") !== ACK_TYPE) throw new Error(`expected an acknowledgment, got ${response.status} ${response.headers.get("content-type")}: ${await response.text()}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== "STA2" || bytes[4] !== 2) throw new Error("not an STA2 body");
  let offset = 5;
  const varint = (): bigint => {
    let value = 0n;
    for (let shift = 0n; ; shift += 7n) {
      const byte = bytes[offset++]!;
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value;
    }
  };
  const accepted = Number(varint());
  const duplicates = Number(varint());
  const count = Number(varint());
  const codes = ["", "invalid_sample", "too_old", "conflict"] as const;
  const rejected = Array.from({ length: count }, () => {
    const seq = varint().toString();
    const code = codes[bytes[offset++]!];
    if (code === undefined || code === "") throw new Error("unknown rejection code");
    return { seq, code };
  });
  if (offset !== bytes.length) throw new Error("trailing acknowledgment bytes");
  return { accepted, duplicates, rejected };
}
