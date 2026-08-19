import pg from 'pg';

export type Db = pg.Pool;

export function createPool(databaseUrl: string): Db {
  return new pg.Pool({ connectionString: databaseUrl, max: 10 });
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const candidate = error as { code?: string; constraint?: string } | null;
  if (!candidate || candidate.code !== '23505') return false;
  return constraint === undefined || candidate.constraint === constraint;
}
