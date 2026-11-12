interface Summary {
  readonly file?: string;
  readonly entryFile?: string;
  readonly counts: { readonly tests: number; readonly passed: number; readonly skipped: number; readonly failed: number; readonly cancelled: number };
}

export default async function* counts(events: AsyncIterable<{ readonly type: string; readonly data: Summary }>): AsyncGenerator<string> {
  for await (const event of events) if (event.type === "test:summary" && event.data.entryFile !== undefined) yield `${JSON.stringify(event.data)}\n`;
}
