export async function readLimitedBytes(request: Request, limit: number): Promise<Uint8Array | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > limit) return null;
  if (request.body === null) return new Uint8Array(0);
  // SAFETY: Workers' Request.body getReader() erases the chunk type; HTTP body chunks are Uint8Array.
  const reader = request.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    const chunk = result.value;
    total += chunk.length;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 1) return chunks[0]!;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

export async function readLimitedText(request: Request, limit: number): Promise<string | null> {
  const bytes = await readLimitedBytes(request, limit);
  return bytes === null ? null : new TextDecoder().decode(bytes);
}
