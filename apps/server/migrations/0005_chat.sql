CREATE TABLE chat_channels (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('global', 'dm')),
  -- 'global' for the Town Square, 'dm:<lowAccountId>:<highAccountId>' for a DM. The
  -- unique index below is what makes opening a DM idempotent under concurrency.
  key text,
  name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES accounts (id) ON DELETE SET NULL,
  archived_at timestamptz
);

CREATE UNIQUE INDEX ux_chat_channels_key ON chat_channels (key) WHERE key IS NOT NULL;

-- The Town Square has no rows here at all: its membership is "everyone with a character",
-- and materialising that would mean a row per account per registration.
CREATE TABLE chat_channel_members (
  channel_id uuid NOT NULL REFERENCES chat_channels (id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  joined_at timestamptz NOT NULL DEFAULT now(),
  last_read_message_id uuid,
  -- Soft leave: authorship history survives someone walking away from the game.
  left_at timestamptz,
  PRIMARY KEY (channel_id, account_id)
);

CREATE INDEX ix_chat_members_account ON chat_channel_members (account_id) WHERE left_at IS NULL;

CREATE TABLE chat_messages (
  id uuid PRIMARY KEY,
  channel_id uuid NOT NULL REFERENCES chat_channels (id) ON DELETE CASCADE,
  author_account_id uuid REFERENCES accounts (id) ON DELETE SET NULL,
  author_character_id uuid REFERENCES characters (id) ON DELETE SET NULL,
  author_name_snapshot text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  moderation text NOT NULL DEFAULT 'clean' CHECK (moderation IN ('clean', 'flagged'))
);

-- Matches the keyset page exactly: ORDER BY created_at DESC, id DESC with a row-comparison
-- cursor, so scrolling back a long channel never degrades into a sort.
CREATE INDEX ix_chat_messages_channel_keyset ON chat_messages (channel_id, created_at DESC, id DESC);
CREATE INDEX ix_chat_messages_author ON chat_messages (author_account_id);

CREATE TABLE chat_blocks (
  blocker_account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  blocked_account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_account_id, blocked_account_id),
  CHECK (blocker_account_id <> blocked_account_id)
);

-- Town Square fan-out asks "who has blocked this author", which reads the other way round.
CREATE INDEX ix_chat_blocks_blocked ON chat_blocks (blocked_account_id);

INSERT INTO chat_channels (id, kind, key, name)
VALUES ('00000000-0000-7000-8000-000000000001', 'global', 'global', 'Town Square');
