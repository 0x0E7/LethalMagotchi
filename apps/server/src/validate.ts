import type { z } from 'zod';
import { ApiError } from './errors.js';

export function parseOrThrow<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  input: unknown,
): z.output<TSchema> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;

  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.length > 0 ? issue.path.join('.') : '_';
    if (!(key in fields)) fields[key] = issue.message;
  }
  throw new ApiError(422, 'VALIDATION_FAILED', 'Some fields need fixing.', { fields });
}
