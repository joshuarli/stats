import { Buffer } from "node:buffer";
import type { Route } from "@playwright/test";
import { HISTORY_CONTENT_TYPE } from "../../src/binary/history";
import { encodeHistory } from "../support/history";

export function fulfillHistory(route: Route, history: unknown) {
  return route.fulfill({ body: Buffer.from(encodeHistory(history)), contentType: HISTORY_CONTENT_TYPE });
}
