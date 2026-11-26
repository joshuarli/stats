import { DatabaseSync } from "node:sqlite";
import { configureSqlite, scheduleCheckpoint } from "../node/sqlite-policy.ts";
import type { SqlObservation } from "../node/runtime.ts";
import { nodeSqlScopes } from "../node/sql.ts";
import { MetricStoreCore } from "./store-core.ts";

export class MetricStore extends MetricStoreCore {
  readonly connection: DatabaseSync;
  private readonly stopCheckpoint: () => void;

  constructor(path = ":memory:", observation?: SqlObservation, report?: (result: { busy: number; log: number; checkpointed: number }) => void) {
    const connection = new DatabaseSync(path);
    try { if (path !== ":memory:") configureSqlite(connection); } catch (error) { connection.close(); throw error; }
    super(nodeSqlScopes(connection, observation).open());
    this.connection = connection;
    this.stopCheckpoint = path === ":memory:" ? () => {} : scheduleCheckpoint(connection, report);
  }

  close(): void {
    this.stopCheckpoint();
    this.connection.close();
  }
}
