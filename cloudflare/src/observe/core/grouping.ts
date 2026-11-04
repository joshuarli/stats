import { GROUPING_FRAMES } from "./limits.ts";
import { isInApp, type StackFrame } from "./stack.ts";

export const GROUPING_VERSION = "observe.group.v1";

export interface GroupingInput {
  readonly operation: string | null;
  readonly name: string;
  readonly message: string | null;
  readonly frames: readonly StackFrame[];
}

export async function fingerprint(input: GroupingInput): Promise<string> {
  const inApp = input.frames.filter(isInApp).slice(0, GROUPING_FRAMES);
  const parts = inApp.length > 0
    ? [GROUPING_VERSION, "frames", input.operation ?? "", input.name, ...inApp.map(frame => frame.fn ?? frame.file)]
    : [GROUPING_VERSION, "message", input.operation ?? "", input.name, normalizeMessage(input.message ?? "")];
  return sha256Hex(parts.join("\u0000"));
}

export function representativeFrame(frames: readonly StackFrame[]): string | null {
  const frame = frames.find(isInApp);
  return frame === undefined ? null : `${frame.fn ?? "?"} (${frame.file}:${frame.line})`;
}

function normalizeMessage(message: string): string {
  return message.replace(/\b[0-9a-f]{8,}\b/giu, "x").replace(/\d+/gu, "0");
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}
