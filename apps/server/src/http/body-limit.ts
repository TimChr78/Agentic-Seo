import type { MiddlewareHandler } from 'hono';

/**
 * Refuse an oversized request before it is buffered. Hono's request body is a stream, so a caller
 * could otherwise send a gigabyte before authentication reads it. `content-length` is checked
 * when present, and a chunked body is counted as it arrives; either way the request is answered
 * with `onTooLarge` and never reaches the route.
 */
export function bodyLimit(limitBytes: number, onTooLarge: (c: Parameters<MiddlewareHandler>[0]) => Response): MiddlewareHandler {
  return async (c, next) => {
    const declared = Number(c.req.header('content-length') ?? '');
    if (Number.isFinite(declared) && declared > limitBytes) return onTooLarge(c);

    const body = c.req.raw.body;
    if (!body) return next();
    let received = 0;
    const counted = body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          received += chunk.byteLength;
          if (received > limitBytes) throw new Error('payload too large');
          controller.enqueue(chunk);
        },
      }),
    );
    try {
      c.req.raw = new Request(c.req.raw, { body: counted, duplex: 'half' } as RequestInit);
    } catch {
      // A GET/HEAD request has no body to wrap.
      return next();
    }
    try {
      return await next();
    } catch (err) {
      if (err instanceof Error && err.message === 'payload too large') return onTooLarge(c);
      throw err;
    }
  };
}
