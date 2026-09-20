/**
 * Thrown by route handlers for an intentional HTTP error response. Mirrors
 * FastAPI's `HTTPException(status, detail)` -- the web frontend's `req()`
 * helper (web/src/lib/api.ts) parses `{ detail }` from error bodies, so the
 * wire shape must match even though the framework changed.
 */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly detail: string,
  ) {
    super(detail)
  }
}
