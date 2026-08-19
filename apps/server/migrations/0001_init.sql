CREATE TABLE accounts (
  id uuid PRIMARY KEY,
  username text NOT NULL,
  username_normalized text NOT NULL,
  password_hash text NOT NULL,
  recovery_email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  owned_cosmetics text[] NOT NULL DEFAULT '{}'
);

CREATE UNIQUE INDEX ux_accounts_username_normalized ON accounts (username_normalized);

CREATE TABLE refresh_tokens (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE INDEX ix_refresh_tokens_account ON refresh_tokens (account_id);

CREATE TABLE species (
  id text PRIMARY KEY,
  display_name text NOT NULL,
  flavor text NOT NULL,
  base_decay_rates jsonb NOT NULL,
  sort_order integer NOT NULL
);

CREATE TABLE personalities (
  id text PRIMARY KEY,
  display_name text NOT NULL,
  decay_modifiers jsonb NOT NULL DEFAULT '{}'::jsonb,
  sort_order integer NOT NULL
);

CREATE TABLE occupations (
  id text PRIMARY KEY,
  display_name text NOT NULL,
  sort_order integer NOT NULL
);

CREATE TABLE countries (
  code text PRIMARY KEY,
  display_name text NOT NULL
);

CREATE TABLE characters (
  id uuid PRIMARY KEY,
  account_id uuid REFERENCES accounts (id) ON DELETE CASCADE,
  species_id text NOT NULL REFERENCES species (id),
  nickname text NOT NULL,
  bio text NOT NULL DEFAULT '',
  origin_country text NOT NULL REFERENCES countries (code),
  origin_city text,
  occupation_id text NOT NULL REFERENCES occupations (id),
  personality_id text NOT NULL REFERENCES personalities (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  stats jsonb NOT NULL,
  last_simulated_at timestamptz NOT NULL DEFAULT now(),
  equipped_cosmetics text[] NOT NULL DEFAULT '{}'
);

CREATE UNIQUE INDEX ux_character_account ON characters (account_id)
  WHERE account_id IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX ix_characters_account_created ON characters (account_id, created_at DESC);
