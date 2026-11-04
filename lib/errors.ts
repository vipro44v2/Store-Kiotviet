export class AppError extends Error {
  constructor(message: string, public readonly code = "APP_ERROR", public readonly status = 500) {
    super(message); this.name = new.target.name;
  }
}
export class ApiError extends AppError { constructor(message: string, status = 502) { super(message, "API_ERROR", status); } }
export class AuthenticationError extends AppError { constructor(message = "Authentication failed") { super(message, "AUTHENTICATION_ERROR", 401); } }
export class RateLimitError extends AppError { constructor(message = "Rate limit exceeded") { super(message, "RATE_LIMIT_ERROR", 429); } }
export class ValidationError extends AppError { constructor(message: string, public readonly details: Record<string, unknown> = {}) { super(message, "VALIDATION_ERROR", 400); } }
export class MappingError extends AppError { constructor(message: string, public readonly details: Record<string, unknown> = {}) { super(message, "MAPPING_ERROR", 422); } }
export class ConflictError extends AppError { constructor(message: string, public readonly details: Record<string, unknown> = {}) { super(message, "CONFLICT_ERROR", 409); } }
export class RetryableError extends AppError { constructor(message: string) { super(message, "RETRYABLE_ERROR", 503); } }
/** A non-idempotent request may or may not have been applied by the provider. Callers must verify before repeating it. */
export class UncertainResultError extends RetryableError {}
export class PermanentError extends AppError { constructor(message: string) { super(message, "PERMANENT_ERROR", 422); } }

/** Errors that retrying cannot fix; jobs failing with these go to manual review. */
export function isManualReviewError(error: unknown) {
  return (
    error instanceof PermanentError ||
    error instanceof MappingError ||
    error instanceof ConflictError ||
    error instanceof ValidationError
  );
}
