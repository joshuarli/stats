import { GATEWAY_IDENTITY_HEADER, GATEWAY_SECRET_HEADER } from "../src/cloudflare/gateway.ts";

export const TEST_GATEWAY_SECRET = "test-gateway-secret";
export const TEST_IDENTITY = "user:tester@example.com";

export function gatewayHeaders(secret = TEST_GATEWAY_SECRET, identity = TEST_IDENTITY): Record<string, string> {
  return { [GATEWAY_SECRET_HEADER]: secret, [GATEWAY_IDENTITY_HEADER]: identity };
}
