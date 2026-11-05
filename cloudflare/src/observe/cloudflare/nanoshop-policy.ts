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
  { name: "cart-remove", method: "POST", pattern: "/cart/items/{variant_id}/remove" }
] as const;

export const NANOSHOP_RPC_METHODS = ["syncCatalog", "readCart", "addToCart", "setCartQuantity", "removeCartItem"] as const;

export type NanoshopRouteName = typeof NANOSHOP_ROUTES[number]["name"];
export type NanoshopRpcMethod = typeof NANOSHOP_RPC_METHODS[number];
export type NanoshopOperation = `request.${NanoshopRouteName}` | "request.unmatched" | "catalog.load" | "catalog.rejected" | `store.rpc.${NanoshopRpcMethod}`;

export const NANOSHOP_OPERATIONS: readonly NanoshopOperation[] = [
  ...NANOSHOP_ROUTES.map(route => `request.${route.name}` as const),
  "request.unmatched",
  "catalog.load",
  "catalog.rejected",
  ...NANOSHOP_RPC_METHODS.map(method => `store.rpc.${method}` as const)
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
