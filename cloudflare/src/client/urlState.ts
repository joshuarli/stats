function hashParts(): { readonly path: string; readonly params: URLSearchParams } {
  const hash = window.location.hash.replace(/^#/u, "");
  const split = hash.indexOf("?");
  return split === -1
    ? { path: hash, params: new URLSearchParams() }
    : { path: hash.slice(0, split), params: new URLSearchParams(hash.slice(split + 1)) };
}

export function readParam(name: string): string | null {
  return hashParts().params.get(name);
}

export function writeParam(name: string, value: string | null): void {
  const { path, params } = hashParts();
  if (value === null) params.delete(name);
  else params.set(name, value);
  const query = params.toString();
  const next = `#${path}${query === "" ? "" : `?${query}`}`;
  if (next !== window.location.hash) window.history.replaceState(window.history.state, "", next);
}
