import { test } from "node:test";
import { openStatsWorker } from "../../local/stack.ts";
import { gatewayHeaders } from "../gateway-headers.ts";
import { agentDeliversABatch } from "./flow.ts";


await test("the real agent binary delivers a binary batch that the real Worker and Durable Object store", async () => {
  const worker = openStatsWorker({ testNowMs: String(Date.now()) });
  const mf = worker.mf;
  try {
    await agentDeliversABatch({
      origin: (await mf.ready).origin,
      credentials: { ...gatewayHeaders() },
      request: async (url, init) => await mf.dispatchFetch(url, init as Parameters<typeof mf.dispatchFetch>[1]) as unknown as Response
    });
  } finally {
    await worker.dispose();
  }
});
