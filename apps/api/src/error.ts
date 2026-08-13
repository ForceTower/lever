import type { JsonValue } from "./service/canonicalize";

/**
 * Thrown anywhere, mapped by `app.onError` to the spec 0001 §5 error shape:
 * `{ error: { code, message, details } }` with the matching HTTP status.
 * Anything that is not a LeverError logs and returns a bare 500.
 */
export class LeverError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: JsonValue | undefined;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    options?: { details?: JsonValue; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "LeverError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = options?.details;
  }
}
