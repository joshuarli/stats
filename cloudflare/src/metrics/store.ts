import { DatabaseSync } from "node:sqlite";
import type { SqlObservation } from "../node/runtime.ts";
import { nodeSqlScopes } from "../node/sql.ts";
import { MetricStoreCore } from "./store-core.ts";

export class MetricStore extends MetricStoreCore {
  readonly connection: DatabaseSync;

  constructor(path = ":memory:", observation?: SqlObservation) {
    const connection = new DatabaseSync(path);
    super(nodeSqlScopes(connection, observation).open());
    this.connection = connection;
  }

  close(): void {
    this.connection.close();
  }
}
