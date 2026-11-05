export function timeText(atMs: number | null): string {
  return atMs === null ? "never" : new Date(atMs).toISOString();
}

export function useColour(env: NodeJS.ProcessEnv, isTty: boolean, json: boolean): boolean {
  return isTty && !json && (env["NO_COLOR"] === undefined || env["NO_COLOR"] === "") && env["TERM"] !== "dumb";
}

export function table(rows: readonly (readonly string[])[]): string[] {
  const widths = rows[0]?.map((_, column) => Math.max(...rows.map(row => row[column]?.length ?? 0))) ?? [];
  return rows.map(row => row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ").trimEnd());
}
