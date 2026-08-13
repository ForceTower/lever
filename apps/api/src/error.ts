import { SQLiteError } from "bun:sqlite";

/**
 * Thrown anywhere, mapped by `app.onError` to the spec 0001 §5 error shape:
 * `{ error: { code, message, details } }` with the matching HTTP status.
 * Anything that is not a LeverError logs and returns a bare 500.
 */
export class LeverError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: unknown;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    options?: { details?: unknown; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "LeverError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = options?.details;
  }
}

export function notFound(entity: string): LeverError {
  return new LeverError(404, "not_found", `${entity} not found`);
}

/**
 * The services map SQLite constraint failures to 409s by operation context
 * (UNIQUE on create/update, the §3.2 RESTRICT FK on condition delete) rather
 * than by extended result code — one operation only has one constraint that
 * can realistically fire.
 */
export function isConstraintError(error: unknown): boolean {
  return error instanceof SQLiteError && (error.code?.startsWith("SQLITE_CONSTRAINT") ?? false);
}
