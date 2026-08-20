import pg from 'pg';

export type Db = pg.Pool;
export type DbClient = pg.PoolClient;

export function createPool(databaseUrl: string): Db {
  return new pg.Pool({ connectionString: databaseUrl, max: 10 });
}

export async function withTransaction<T>(db: Db, run: (client: DbClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const candidate = error as { code?: string; constraint?: string } | null;
  if (!candidate || candidate.code !== '23505') return false;
  return constraint === undefined || candidate.constraint === constraint;
}
