import { MAX_FRAMES_PER_ERROR } from "./limits.ts";

export interface StackFrame {
  readonly fn: string | null;
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

export interface OriginalPosition {
  readonly fn: string | null;
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

export interface SymbolicatedFrame extends StackFrame {
  readonly original: OriginalPosition | null;
}

const FRAME_WITH_FUNCTION = /^\s*at (?:async )?(.+?) \((.+):(\d+):(\d+)\)$/u;
const FRAME_WITHOUT_FUNCTION = /^\s*at (?:async )?(.+):(\d+):(\d+)$/u;
const RUNTIME_FILE = /^(?:node:|cloudflare:|internal[/:]|native\b|<anonymous>$)/u;

export function parseStack(stack: string): StackFrame[] {
  const frames: StackFrame[] = [];
  for (const raw of stack.split("\n")) {
    const frame = parseFrame(raw);
    if (frame === null) continue;
    frames.push(frame);
    if (frames.length === MAX_FRAMES_PER_ERROR) break;
  }
  return frames;
}

function parseFrame(raw: string): StackFrame | null {
  const named = FRAME_WITH_FUNCTION.exec(raw);
  if (named !== null) return frame(named[1] ?? null, named[2], named[3], named[4]);
  const bare = FRAME_WITHOUT_FUNCTION.exec(raw);
  if (bare !== null) return frame(null, bare[1], bare[2], bare[3]);
  return null;
}

function frame(fn: string | null, file: string | undefined, line: string | undefined, column: string | undefined): StackFrame | null {
  if (file === undefined || line === undefined || column === undefined) return null;
  return { fn: fn === null ? null : normalizeFunction(fn), file: normalizeFile(file), line: Number(line), column: Number(column) };
}

function normalizeFunction(fn: string): string {
  return fn.replace(/^Object\./u, "").replace(/ \[as [^\]]+\]$/u, "");
}

export function normalizeFile(file: string): string {
  const path = file.replace(/^file:\/\//u, "");
  const source = path.lastIndexOf("/src/");
  if (source >= 0) return path.slice(source + 1);
  if (path.startsWith("src/")) return path;
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(slash + 1) : path;
}

export function isInApp(frame: StackFrame): boolean {
  return !RUNTIME_FILE.test(frame.file);
}

export function formatFrames(frames: readonly StackFrame[]): string {
  const field = (text: string): string => text.replace(/[\t\n\r]/gu, " ");
  return frames.map(f => `${f.fn === null ? "?" : field(f.fn)}\t${field(f.file)}\t${f.line}\t${f.column}`).join("\n");
}

export function readFrames(text: string): StackFrame[] {
  if (text === "") return [];
  return text.split("\n").map(row => {
    const [fn, file, line, column] = row.split("\t");
    if (fn === undefined || file === undefined || line === undefined || column === undefined) throw new Error("stored frame is malformed");
    return { fn: fn === "?" ? null : fn, file, line: Number(line), column: Number(column) };
  });
}
