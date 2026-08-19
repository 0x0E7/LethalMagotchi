import type { ApiErrorCode } from '@lethalmagotchi/shared';

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: ApiErrorCode;
  readonly fields: Record<string, string> | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    statusCode: number,
    code: ApiErrorCode,
    message: string,
    options: { fields?: Record<string, string>; retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.fields = options.fields;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export const unauthorized = (message = 'Sign in to continue.') =>
  new ApiError(401, 'UNAUTHORIZED', message);

export const invalidCredentials = () =>
  new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid username or password.');
