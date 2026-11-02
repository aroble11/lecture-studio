type BodyResult<T> = { ok: true; value: T } | { ok: false; response: Response };

function reject(status: number, error: string): BodyResult<never> {
  return { ok: false, response: Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } }) };
}

/** Bound application buffering by actual incoming bytes, even without a truthful Content-Length.
 * The hosting platform may buffer the request independently before handing it to this reader.
 */
export async function readBoundedBytes(request: Request, maxBytes: number): Promise<BodyResult<Uint8Array>> {
  const tooLarge = () => reject(413, `Request too large (max ${maxBytes} bytes)`);
  const cancelBody = () => { void request.body?.cancel().catch(() => {}); };
  const encoding = request.headers.get("content-encoding")?.trim().toLowerCase();
  if (encoding && encoding !== "identity") {
    cancelBody();
    return reject(415, "Compressed request bodies are not supported");
  }
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) {
      cancelBody();
      return reject(400, "Invalid Content-Length");
    }
    if (Number(declared) > maxBytes) {
      cancelBody();
      return tooLarge();
    }
  }
  if (!request.body) return { ok: true, value: new Uint8Array(0) };

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = request.body.getReader();
    // One fixed buffer avoids unbounded overhead from a large number of tiny stream chunks.
    const bytes = new Uint8Array(maxBytes);
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { ok: true, value: bytes.subarray(0, size) };
      if (value.byteLength > maxBytes - size) {
        // Do not wait for cancellation acknowledgement from a slow/uncooperative sender.
        void reader.cancel().catch(() => {});
        return tooLarge();
      }
      bytes.set(value, size);
      size += value.byteLength;
    }
  } catch {
    if (reader) void reader.cancel().catch(() => {});
    return reject(400, "Could not read request body");
  } finally {
    reader?.releaseLock();
  }
}

export async function readBoundedJson<T>(request: Request, maxBytes: number): Promise<BodyResult<T>> {
  const body = await readBoundedBytes(request, maxBytes);
  if (!body.ok) return body;
  try {
    // Decode only after the byte limit is established; invalid UTF-8 is a bad request.
    return { ok: true, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body.value)) as T };
  } catch {
    return reject(400, "Send valid UTF-8 JSON");
  }
}
