import { sampled } from "./sampling.ts";
import type { Stage } from "./model.ts";

export const NANOSHOP_ROUTES = [
  { name: "home", method: "GET", pattern: "/" },
  { name: "products", method: "GET", pattern: "/products" },
  { name: "search", method: "GET", pattern: "/search" },
  { name: "collections", method: "GET", pattern: "/collections" },
  { name: "collection", method: "GET", pattern: "/collections/{handle}" },
  { name: "product", method: "GET", pattern: "/products/{handle}" },
  { name: "cart", method: "GET", pattern: "/cart" },
  { name: "cart-add", method: "POST", pattern: "/cart/items" },
  { name: "cart-set", method: "POST", pattern: "/cart/items/{variant_id}" },
  { name: "cart-remove", method: "POST", pattern: "/cart/items/{variant_id}/remove" },
  { name: "checkout", method: "GET", pattern: "/checkout" },
  { name: "checkout-review", method: "POST", pattern: "/checkout/review" },
  { name: "checkout-quote", method: "GET", pattern: "/checkout/quotes/{ref}" },
  { name: "checkout-refresh", method: "POST", pattern: "/checkout/quotes/{ref}/refresh" },
  { name: "checkout-accept", method: "POST", pattern: "/checkout/quotes/{ref}/accept" },
  { name: "checkout-attempt", method: "GET", pattern: "/checkout/attempts/{ref}" },
  { name: "order-lookup", method: "GET", pattern: "/orders/lookup" },
  { name: "order-lookup-request", method: "POST", pattern: "/orders/lookup/request" },
  { name: "order", method: "GET", pattern: "/orders/{number}" },
  { name: "order-access", method: "GET", pattern: "/orders/access/{token}" },
  { name: "sitemap", method: "GET", pattern: "/sitemap.xml" },
  { name: "robots", method: "GET", pattern: "/robots.txt" },
  { name: "info", method: "GET", pattern: "/pages/{slug}" },
  { name: "admin-home", method: "GET", pattern: "/admin" },
  { name: "admin-sign-in", method: "GET", pattern: "/admin/sign-in" },
  { name: "admin-sign-in-callback", method: "GET", pattern: "/admin/sign-in/callback" },
  { name: "admin-sign-out", method: "POST", pattern: "/admin/sign-out" },
  { name: "admin-reauth", method: "GET", pattern: "/admin/reauth" },
  { name: "admin-products", method: "GET", pattern: "/admin/products" },
  { name: "admin-products-bulk", method: "POST", pattern: "/admin/products" },
  { name: "admin-product-new", method: "GET", pattern: "/admin/products/new" },
  { name: "admin-product-create", method: "POST", pattern: "/admin/products/new" },
  { name: "admin-media-upload", method: "POST", pattern: "/admin/media" },
  { name: "admin-collections", method: "GET", pattern: "/admin/collections" },
  { name: "admin-collection-new", method: "GET", pattern: "/admin/collections/new" },
  { name: "admin-collection-create", method: "POST", pattern: "/admin/collections/new" },
  { name: "admin-settings", method: "GET", pattern: "/admin/settings" },
  { name: "admin-settings-checkout", method: "POST", pattern: "/admin/settings" },
  { name: "admin-settings-tax", method: "GET", pattern: "/admin/settings/tax" },
  { name: "admin-settings-tax-save", method: "POST", pattern: "/admin/settings/tax" },
  { name: "admin-settings-shipping", method: "GET", pattern: "/admin/settings/shipping" },
  { name: "admin-settings-shipping-save", method: "POST", pattern: "/admin/settings/shipping" },
  { name: "admin-settings-identity", method: "GET", pattern: "/admin/settings/identity" },
  { name: "admin-settings-identity-save", method: "POST", pattern: "/admin/settings/identity" },
  { name: "admin-pages", method: "GET", pattern: "/admin/pages" },
  { name: "admin-orders", method: "GET", pattern: "/admin/orders" },
  { name: "admin-operations", method: "GET", pattern: "/admin/operations" },
  { name: "admin-stock", method: "GET", pattern: "/admin/stock/{variant_id}" },
  { name: "admin-stock-adjust", method: "POST", pattern: "/admin/stock/{variant_id}" },
  { name: "admin-stock-track", method: "POST", pattern: "/admin/stock/{variant_id}/track" },
  { name: "admin-product", method: "GET", pattern: "/admin/products/{product_id}" },
  { name: "admin-product-update", method: "POST", pattern: "/admin/products/{product_id}" },
  { name: "admin-product-preview", method: "GET", pattern: "/admin/products/{product_id}/preview" },
  { name: "admin-asset", method: "GET", pattern: "/admin/assets/{file}" },
  { name: "admin-collection", method: "GET", pattern: "/admin/collections/{collection_id}" },
  { name: "admin-collection-update", method: "POST", pattern: "/admin/collections/{collection_id}" },
  { name: "admin-page", method: "GET", pattern: "/admin/pages/{kind}" },
  { name: "admin-page-save", method: "POST", pattern: "/admin/pages/{kind}" },
  { name: "admin-page-review", method: "POST", pattern: "/admin/pages/{kind}/review" },
  { name: "admin-order", method: "GET", pattern: "/admin/orders/{number}" },
  { name: "admin-order-ship", method: "POST", pattern: "/admin/orders/{number}" },
  { name: "admin-order-note", method: "POST", pattern: "/admin/orders/{number}/notes" },
  { name: "admin-order-refund", method: "POST", pattern: "/admin/orders/{number}/refunds" },
  { name: "admin-order-cancel", method: "POST", pattern: "/admin/orders/{number}/cancel" },
  { name: "admin-order-return", method: "POST", pattern: "/admin/orders/{number}/returns" },
  { name: "admin-order-restock", method: "POST", pattern: "/admin/orders/{number}/restocks" },
  { name: "admin-order-email", method: "POST", pattern: "/admin/orders/{number}/emails" },
  { name: "admin-order-access-revoke", method: "POST", pattern: "/admin/orders/{number}/access/revoke" },
  { name: "admin-order-slip", method: "GET", pattern: "/admin/orders/{number}/packing-slip" },
  { name: "admin-media", method: "GET", pattern: "/admin/media/{media_id}/{file}" },
  { name: "webhook", method: "POST", pattern: "/webhooks/stripe" }
] as const;

export const NANOSHOP_RPC_METHODS = ["syncCatalog", "readCart", "addToCart", "setCartQuantity", "removeCartItem", "commerceCommand", "commerceQuery"] as const;

export const NANOSHOP_EXTRA_OPERATIONS = ["store.alarm", "worker.scheduled", "payment.unknown", "payment.blocked", "work.dead", "inventory.invariant", "email.failed", "provider.error"] as const;

export type NanoshopRouteName = typeof NANOSHOP_ROUTES[number]["name"];
export type NanoshopRpcMethod = typeof NANOSHOP_RPC_METHODS[number];
export type NanoshopOperation = `request.${NanoshopRouteName}` | "request.unmatched" | "catalog.load" | "catalog.rejected" | `store.rpc.${NanoshopRpcMethod}` | typeof NANOSHOP_EXTRA_OPERATIONS[number];

export const NANOSHOP_OPERATIONS: readonly NanoshopOperation[] = [
  ...NANOSHOP_ROUTES.map(route => `request.${route.name}` as const),
  "request.unmatched",
  "catalog.load",
  "catalog.rejected",
  ...NANOSHOP_RPC_METHODS.map(method => `store.rpc.${method}` as const),
  ...NANOSHOP_EXTRA_OPERATIONS
];

interface RouteShape {
  readonly segments: readonly string[];
  readonly template: string;
}

const PARAMETER = /^\{([a-z_]+)\}$/u;

const SHAPES: readonly RouteShape[] = NANOSHOP_ROUTES.map(route => {
  const segments = route.pattern.slice(1).split("/");
  return { segments, template: `/${segments.map(segment => segment.replace(PARAMETER, ":$1")).join("/")}` };
});

export function nanoshopWorkerRoute(path: string): string | null {
  const actual = path.slice(1).split("/");
  for (const shape of SHAPES) {
    if (shape.segments.length === actual.length && shape.segments.every((expected, index) => PARAMETER.test(expected) ? actual[index] !== "" : actual[index] === expected)) return shape.template;
  }
  return null;
}

const ROUTE_OPERATIONS: ReadonlyMap<string, NanoshopOperation> = new Map(NANOSHOP_ROUTES.map((route, index) => [`${route.method} ${SHAPES[index]!.template}`, `request.${route.name}` as const]));
const UNMATCHED_LABEL = /^[A-Z]{3,7} unmatched$/u;
const SCHEDULED_LABEL = /^scheduled /u;
const RPC_OPERATIONS: ReadonlyMap<string, NanoshopOperation> = new Map([...NANOSHOP_RPC_METHODS.map(method => [method, `store.rpc.${method}`] as const), ["alarm", "store.alarm"]]);

export function nanoshopLabelOperation(stage: Stage, label: string): NanoshopOperation | null {
  if (stage === "worker") return UNMATCHED_LABEL.test(label) ? "request.unmatched" : SCHEDULED_LABEL.test(label) ? "worker.scheduled" : ROUTE_OPERATIONS.get(label) ?? null;
  return RPC_OPERATIONS.get(label.slice(label.lastIndexOf(".") + 1)) ?? null;
}

const UNMATCHED_METHODS = ["GET", "HEAD", "POST", "PUT", "DELETE", "CONNECT", "OPTIONS", "TRACE", "PATCH"] as const;
const CRON_TRIGGERS = 1;

export const NANOSHOP_ROUTES_PER_CLASS = NANOSHOP_ROUTES.length + UNMATCHED_METHODS.length + CRON_TRIGGERS;

export const NANOSHOP_SAMPLING = sampled({ keepPerMillion: 2_000, slowWallMs: 1_000, slowCpuMs: 50 });
