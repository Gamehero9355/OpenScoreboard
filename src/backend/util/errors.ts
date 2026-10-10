/**
 * Errors that are safe to show to an operator. Anything that is not an
 * EngineError is reported as a generic failure so no stack trace ever reaches a
 * browser on the LAN.
 */
export type ErrorCode =
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'INVALID_STATE'
  | 'NO_BRACKET'
  | 'NO_TOURNAMENT'
  | 'MATCH_NOT_FOUND'
  | 'PARTICIPANT_NOT_FOUND'
  | 'FIELD_BUSY'
  | 'FIELD_LOCKED'
  | 'FIELD_NOT_FOUND'
  | 'DUPLICATE_RESULT'
  | 'NO_WINNER'
  | 'SHOOTOUT_REQUIRED'
  | 'TEAM_BUSY'
  | 'DOWNSTREAM_STARTED'
  | 'INVALID_SCORE'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'TOO_MANY_REQUESTS'
  | 'CONFLICT'
  | 'DATABASE_ERROR'
  | 'INTERNAL';

export class EngineError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | null;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.details = details ?? null;
  }
}

export function isEngineError(error: unknown): error is EngineError {
  return error instanceof EngineError;
}

export function errorMessage(error: unknown): string {
  if (isEngineError(error)) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function errorCode(error: unknown): ErrorCode {
  if (isEngineError(error)) return error.code;
  return 'INTERNAL';
}
