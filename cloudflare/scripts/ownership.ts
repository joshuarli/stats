import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout } from "node:timers/promises";

export async function acquireOwnership(path: string, signal: AbortSignal, waitMs = 30_000): Promise<() => void> {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  const deadline = performance.now() + waitMs;
  try {
    for (;;) {
      signal.throwIfAborted();
      try { db.exec("BEGIN IMMEDIATE"); break; }
      catch (error) {
        if (!(error instanceof Error && /locked|busy/iu.test(error.message))) throw error;
        if (performance.now() >= deadline) throw new Error(`ownership timeout: ${path}; owner details ${path}.owner.json`);
        await setTimeout(50, undefined, { signal });
      }
    }
    writeFileSync(`${path}.owner.json`, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try { writeFileSync(`${path}.owner.json`, JSON.stringify({ released: true, pid: process.pid })); db.exec("ROLLBACK"); }
      finally { db.close(); }
    };
  } catch (error) { db.close(); throw error; }
}
