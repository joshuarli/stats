import { DatabaseSync } from "node:sqlite";
import { nodeSqlScopes } from "../node/sql.ts";
import { MetricStoreCore } from "./store-core.ts";

export class MetricStore extends MetricStoreCore {
  readonly connection: DatabaseSync;

  constructor(path = ":memory:") {
    const connection = new DatabaseSync(path);
    super(nodeSqlScopes(connection).open());
    this.connection = connection;
  }

  close(): void {
    this.connection.close();
  }
}
