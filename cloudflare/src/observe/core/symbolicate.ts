import { originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";
import { normalizeFile, type StackFrame, type SymbolicatedFrame } from "./stack.ts";

const CACHED_MAPS = 4;

export type MapLoader = (version: string, file: string) => string | null;

export function createSymbolicator(load: MapLoader): (frames: readonly StackFrame[], version: string | null) => SymbolicatedFrame[] {
  const cache = new Map<string, TraceMap>();
  const mapFor = (version: string, file: string): TraceMap | null => {
    const key = `${version}\u0000${file}`;
    const cached = cache.get(key);
    if (cached !== undefined) {
      cache.delete(key);
      cache.set(key, cached);
      return cached;
    }
    const text = load(version, file);
    if (text === null) return null;
    const parsed = new TraceMap(text);
    cache.set(key, parsed);
    if (cache.size > CACHED_MAPS) cache.delete(cache.keys().next().value!);
    return parsed;
  };
  return (frames, version) => frames.map(frame => {
    const map = version === null ? null : mapFor(version, frame.file);
    if (map === null) return { ...frame, original: null };
    const position = originalPositionFor(map, { line: frame.line, column: Math.max(0, frame.column - 1) });
    if (position.source === null || position.line === null || position.column === null) return { ...frame, original: null };
    return { ...frame, original: { fn: position.name ?? frame.fn, file: normalizeFile(position.source), line: position.line, column: position.column + 1 } };
  });
}
