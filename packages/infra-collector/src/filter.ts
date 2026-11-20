import { catalog } from "./catalog.ts";
import { MAX_SCRAPE_BYTES } from "../../../cloudflare/src/metrics/exposition.ts";

const MAX_LINE_BYTES = 65536;
const MAX_FILTERED_CHARS = 65536;

export async function filterScrape(body: AsyncIterable<Uint8Array>, onBytes: (bytes: number) => void): Promise<{ text: string; unlisted: number }> {
  const decoder = new TextDecoder();
  let pending = "";
  let filtered = "";
  let size = 0;
  let unlisted = 0;
  const line = (value: string) => {
    if (!value.trim()) return;
    if (value.startsWith("#")) {
      if (!/^#(?:\s|$)/u.test(value)) throw new Error("parse_error");
      const type = /^# TYPE ([a-zA-Z_:][a-zA-Z0-9_:]*) /u.exec(value);
      if (type && Object.hasOwn(catalog, type[1]!)) filtered += `${value}\n`;
    } else {
      const sample = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+(\S+)(?:\s+\d+)?\s*$/u.exec(value);
      if (!sample) throw new Error("parse_error");
      const name = sample[1]!;
      const family = Object.hasOwn(catalog, name) ? name : name.replace(/_(?:bucket|sum|count)$/u, "");
      if (Object.hasOwn(catalog, family)) filtered += `${value}\n`;
      else unlisted++;
    }
    if (filtered.length > MAX_FILTERED_CHARS) throw new Error("parse_error");
  };
  for await (const chunk of body) {
    size += chunk.length;
    onBytes(Math.min(size, MAX_SCRAPE_BYTES));
    if (size > MAX_SCRAPE_BYTES) throw new Error("too_large");
    for (let offset = 0; offset < chunk.length; offset += 8192) {
      pending += decoder.decode(chunk.subarray(offset, offset + 8192), { stream: true });
      let newline: number;
      while ((newline = pending.indexOf("\n")) !== -1) {
        if (newline > MAX_LINE_BYTES) throw new Error("parse_error");
        const value = pending.slice(0, newline).replace(/\r$/u, "");
        line(value);
        pending = pending.slice(newline + 1);
      }
      if (pending.length > MAX_LINE_BYTES) throw new Error("parse_error");
    }
  }
  pending += decoder.decode();
  if (pending) line(pending);
  return { text: filtered, unlisted };
}
