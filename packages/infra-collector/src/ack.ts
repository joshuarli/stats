import type { Scrape } from "../../../cloudflare/src/metrics/codec.ts";

type Outcome = { target: string; sequence: number; status: "accepted" | "duplicate" | "rejected" };
export function reconcileAck(scrapes: Scrape[], acknowledgement: unknown): Outcome[] | null {
  if (!acknowledgement || typeof acknowledgement !== "object") return null;
  const ack = acknowledgement as { accepted?: unknown; duplicates?: unknown; rejected?: unknown; outcomes?: unknown };
  if (!Number.isSafeInteger(ack.accepted) || !Number.isSafeInteger(ack.duplicates) || !Array.isArray(ack.rejected) || !Array.isArray(ack.outcomes) || ack.outcomes.length !== scrapes.length) return null;
  const outcomes = ack.outcomes as Outcome[];
  const seen = new Set<string>();
  for (const item of outcomes) {
    if (!item || typeof item !== "object") return null;
    const key = `${item.target}:${item.sequence}`;
    if (seen.has(key) || !scrapes.some(s => s.target === item.target && s.sequence === item.sequence) || !["accepted", "duplicate", "rejected"].includes(item.status)) return null;
    seen.add(key);
  }
  if (outcomes.filter(o => o.status === "accepted").length !== ack.accepted || outcomes.filter(o => o.status === "duplicate").length !== ack.duplicates || outcomes.filter(o => o.status === "rejected").length !== ack.rejected.length) return null;
  const rejected = ack.rejected as Array<{ target: string; sequence: number }>;
  const uniqueRejected = new Set(rejected.map(r => r && `${r.target}:${r.sequence}`));
  if (uniqueRejected.size !== rejected.length || !rejected.every(r => r && outcomes.some(o => o.target === r.target && o.sequence === r.sequence && o.status === "rejected"))) return null;
  return outcomes;
}
