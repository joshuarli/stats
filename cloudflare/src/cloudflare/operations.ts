import { markInvocation, markOperation } from "../observe/cloudflare/mark.ts";
import type { OperationSink } from "../operations.ts";

export const cloudflareOperations: OperationSink = {
  invocation: markInvocation,
  operation: markOperation
};
