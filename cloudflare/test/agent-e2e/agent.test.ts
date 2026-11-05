import { test } from "node:test";
import { openStatsWorker } from "../../local/stack.ts";
import { accessToken } from "../access-token.ts";
import { agentDeliversABatch } from "./flow.ts";


await test("the real agent binary delivers a binary batch that the real Worker and Durable Object store", async () => {
  const mf = openStatsWorker(String(Date.now()));
  try {
    await agentDeliversABatch({
      origin: (await mf.ready).origin,
      credentials: { "cf-access-jwt-assertion": await accessToken() },
      request: async (url, init) => await mf.dispatchFetch(url, init as Parameters<typeof mf.dispatchFetch>[1]) as unknown as Response
    });
  } finally {
    await mf.dispose();
  }
});
