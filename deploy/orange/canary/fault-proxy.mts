import { createServer, request } from "node:http";
import { decodeColumns, encodeColumns } from "../../../cloudflare/src/binary/columns.ts";

export async function faultProxy(origin: string, mode: "body" | "missing-history" | "corrupt-history" = "body") {
  let altered = false;
  const server = createServer((incoming, outgoing) => {
    const target = new URL(incoming.url!, origin);
    const upstream = request(target, { method: incoming.method, headers: { ...incoming.headers, host: target.host } }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => {
        let body = Buffer.concat(chunks);
        const headers = { ...response.headers };
        if (!altered && mode === "body" && response.statusCode === 200 && incoming.url === "/api/v1/capabilities") {
          altered = true;
          body = Buffer.from("{}");
          delete headers["content-encoding"];
          delete headers["transfer-encoding"];
          headers["content-length"] = String(body.length);
        }
        if (!altered && mode !== "body" && response.statusCode === 200 && incoming.url?.includes("/history?")) {
          const frame = decodeColumns(body);
          const tables = frame.tables.map(table => {
            if (table.rows < 2) throw new Error("history fault requires two rows");
            if (mode === "missing-history") return { ...table, rows: table.rows - 1, columns: table.columns.map(column => ({ ...column, values: column.values.slice(0, -1), validity: column.validity === null ? null : Uint8Array.from([column.validity[0]! & ((1 << (table.rows - 1)) - 1)]) })) };
            return { ...table, columns: table.columns.map(column => {
              if (column.name !== "cpuCount") return column;
              const values = column.values.slice();
              if (values instanceof Float64Array) values[0] = values[0]! + 1;
              return { ...column, values };
            }) };
          });
          body = Buffer.from(encodeColumns({ metadata: frame.metadata, tables }));
          altered = true;
          delete headers["content-encoding"];
          delete headers["transfer-encoding"];
          headers["content-length"] = String(body.length);
        }
        outgoing.writeHead(response.statusCode!, headers).end(body);
      });
    });
    upstream.on("error", error => outgoing.destroy(error));
    incoming.pipe(upstream);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("proxy did not bind");
  return { origin: `http://127.0.0.1:${address.port}`, altered: () => altered, stop: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}
