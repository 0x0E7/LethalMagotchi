import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const REPO_ROOT_ENV = path.resolve(fileURLToPath(new URL('../../../.env', import.meta.url)));

function loadDotEnv(): void {
  if (existsSync(REPO_ROOT_ENV)) process.loadEnvFile(REPO_ROOT_ENV);
}

/** `false`, or the proxies whose `X-Forwarded-For` may be believed. */
export type TrustProxy = false | string[];

const PROXY_PRESETS = ['loopback', 'linklocal', 'uniquelocal'];
const ADDRESS_OR_CIDR = /^[0-9a-fA-F.:]+(\/\d{1,3})?$/;

function trustProxyEntries(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseTrustProxy(value: string): TrustProxy {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === 'false') return false;
  return trustProxyEntries(trimmed);
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
  /**
   * Whose `X-Forwarded-For` may be believed: `false` (the default) uses the raw socket
   * address, anything else is a comma-separated allowlist of proxy addresses/CIDRs.
   *
   * `true` is refused on purpose — it resolves `request.ip` to the leftmost, entirely
   * client-supplied entry even when a real proxy has appended its own hop, so one header
   * would defeat every per-IP limit here. A bare hop count is refused too: Fastify 5 reads
   * a numeric `trustProxy` as "trust nothing", so it would quietly do the opposite of what
   * the operator who set it intended.
   */
  TRUST_PROXY: z
    .string()
    .default('false')
    .superRefine((value, ctx) => {
      const trimmed = value.trim();
      if (trimmed === 'true') {
        ctx.addIssue({
          code: 'custom',
          message:
            'TRUST_PROXY=true believes a client-supplied X-Forwarded-For; list the proxy addresses/CIDRs instead',
        });
        return;
      }
      if (/^\d+$/.test(trimmed)) {
        ctx.addIssue({
          code: 'custom',
          message: 'TRUST_PROXY does not take a hop count; list the proxy addresses/CIDRs instead',
        });
        return;
      }
      for (const entry of trustProxyEntries(trimmed)) {
        if (entry === 'false' || PROXY_PRESETS.includes(entry) || ADDRESS_OR_CIDR.test(entry)) continue;
        ctx.addIssue({ code: 'custom', message: `TRUST_PROXY entry "${entry}" is not an address, CIDR or preset` });
      }
    })
    .transform(parseTrustProxy),
  // Tournament timing is configurable so a run can be exercised without waiting on the
  // real Israel-time schedule; production leaves every one of these at its default.
  TOURNAMENT_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  TOURNAMENT_MODE: z.enum(['daily', 'interval']).default('daily'),
  TOURNAMENT_INTERVAL_MS: z.coerce.number().int().positive().default(4 * 60 * 60_000),
  TOURNAMENT_REGISTRATION_LEAD_MS: z.coerce.number().int().positive().default(5 * 60_000),
  TOURNAMENT_TICK_MS: z.coerce.number().int().positive().default(1_000),
  TOURNAMENT_TURN_MS: z.coerce.number().int().positive().default(20_000),
  TOURNAMENT_SHOWDOWN_MS: z.coerce.number().int().nonnegative().default(2_500),
  TOURNAMENT_ROUND_BREAK_MS: z.coerce.number().int().nonnegative().default(6_000),
  TOURNAMENT_HANDS_PER_TABLE: z.coerce.number().int().positive().max(10).default(3),
});

export interface TournamentConfig {
  enabled: boolean;
  mode: 'daily' | 'interval';
  intervalMs: number;
  registrationLeadMs: number;
  tickMs: number;
  turnMs: number;
  showdownMs: number;
  roundBreakMs: number;
  handsPerTable: number;
}

export type Config = {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  host: string;
  databaseUrl: string;
  jwtSecret: string;
  clientOrigins: string[];
  cookieSecure: boolean;
  clientDist: string | undefined;
  trustProxy: TrustProxy;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  tournament: TournamentConfig;
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
    trustProxy: value.TRUST_PROXY,
    accessTokenTtlSeconds: 15 * 60,
    refreshTokenTtlSeconds: 30 * 24 * 60 * 60,
    tournament: {
      enabled: value.TOURNAMENT_ENABLED,
      mode: value.TOURNAMENT_MODE,
      intervalMs: value.TOURNAMENT_INTERVAL_MS,
      registrationLeadMs: value.TOURNAMENT_REGISTRATION_LEAD_MS,
      tickMs: value.TOURNAMENT_TICK_MS,
      turnMs: value.TOURNAMENT_TURN_MS,
      showdownMs: value.TOURNAMENT_SHOWDOWN_MS,
      roundBreakMs: value.TOURNAMENT_ROUND_BREAK_MS,
      handsPerTable: value.TOURNAMENT_HANDS_PER_TABLE,
    },
  };
}

export const DEFAULT_TOURNAMENT_CONFIG: TournamentConfig = {
  enabled: true,
  mode: 'daily',
  intervalMs: 4 * 60 * 60_000,
  registrationLeadMs: 5 * 60_000,
  tickMs: 1_000,
  turnMs: 20_000,
  showdownMs: 2_500,
  roundBreakMs: 6_000,
  handsPerTable: 3,
};

export const REFRESH_COOKIE_NAME = 'lm_refresh';
export const REFRESH_COOKIE_PATH = '/api/v1/auth';
