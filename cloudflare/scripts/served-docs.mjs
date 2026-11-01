import { readFileSync } from "node:fs";

const SERVED_DOCS = ["protocol.md", "architecture.md"];

export function servedDocs() {
  return {
    name: "served-docs",
    applyToEnvironment: environment => environment.name === "client",
    generateBundle() {
      for (const name of SERVED_DOCS) {
        this.emitFile({ type: "asset", fileName: `docs/${name}`, source: readFileSync(new URL(`../../docs/${name}`, import.meta.url)) });
      }
    }
  };
}
