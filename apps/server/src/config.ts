import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const REPO_ROOT_ENV = path.resolve(fileURLToPath(new URL('../../../.env', import.meta.url)));

function loadDotEnv(): void {
  if (existsSync(REPO_ROOT_ENV)) process.loadEnvFile(REPO_ROOT_ENV);
}

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(16),
  CLIENT_ORIGIN: z.string().default('http://localhost:5173'),
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  CLIENT_DIST: z.string().optional(),
});

export type Config = {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  host: string;
  databaseUrl: string;
  jwtSecret: string;
  clientOrigins: string[];
  cookieSecure: boolean;
  clientDist: string | undefined;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
};

export function loadConfig(env?: NodeJS.ProcessEnv): Config {
  if (env === undefined) loadDotEnv();
  const parsed = configSchema.safeParse(env ?? process.env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n');
    throw new Error(`Invalid server configuration:\n${details}`);
  }
  const value = parsed.data;
  return {
    nodeEnv: value.NODE_ENV,
    port: value.PORT,
    host: value.HOST,
    databaseUrl: value.DATABASE_URL,
    jwtSecret: value.JWT_SECRET,
    clientOrigins: value.CLIENT_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean),
    cookieSecure: value.COOKIE_SECURE,
    clientDist: value.CLIENT_DIST,
    accessTokenTtlSeconds: 15 * 60,
    refreshTokenTtlSeconds: 30 * 24 * 60 * 60,
  };
}

export const REFRESH_COOKIE_NAME = 'lm_refresh';
export const REFRESH_COOKIE_PATH = '/api/v1/auth';
