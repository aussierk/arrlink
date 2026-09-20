/** Thrown by route handlers for an intentional HTTP error response. The web
 * frontend's `req()` helper parses `{ detail }` from error bodies. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly detail: string,
  ) {
    super(detail)
  }
}
