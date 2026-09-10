-- `active_duel_id` is the symmetric twin of `seated_table_id`: one engagement lock per
-- system, both checked in both directions, so a wallet can never be committed to a duel
-- and a poker table at the same time.
ALTER TABLE characters
  ADD COLUMN active_duel_id uuid,
  ADD COLUMN duel_wins integer NOT NULL DEFAULT 0,
  ADD COLUMN duel_losses integer NOT NULL DEFAULT 0,
  -- Rolling 24h from the decline, never a calendar day: no timezone ever enters the model,
  -- and no cron is needed since every read is a comparison against now().
  ADD COLUMN chicken_badge_until timestamptz;

ALTER TABLE rebirth_events ADD COLUMN duel_id uuid;

CREATE TABLE duel_invites (
  id uuid PRIMARY KEY,
  from_character_id uuid NOT NULL REFERENCES characters (id) ON DELETE CASCADE,
  to_character_id uuid NOT NULL REFERENCES characters (id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'accepted', 'declined', 'expired', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  resolved_at timestamptz,
  duel_id uuid,
  CHECK (from_character_id <> to_character_id)
);

-- One live challenge per direction at a time: the partial unique index is what makes
-- "you already have a challenge out to them" a database fact rather than a read-then-write.
CREATE UNIQUE INDEX ux_duel_invites_pending_pair
  ON duel_invites (from_character_id, to_character_id)
  WHERE state = 'pending';

CREATE INDEX ix_duel_invites_to_pending ON duel_invites (to_character_id) WHERE state = 'pending';

-- The per-pair decline cooldown is a query against invite history, not a table of its own.
CREATE INDEX ix_duel_invites_declines
  ON duel_invites (from_character_id, to_character_id, resolved_at DESC)
  WHERE state = 'declined';

CREATE TABLE duels (
  id uuid PRIMARY KEY,
  invite_id uuid NOT NULL REFERENCES duel_invites (id) ON DELETE CASCADE,
  challenger_id uuid NOT NULL REFERENCES characters (id) ON DELETE CASCADE,
  opponent_id uuid NOT NULL REFERENCES characters (id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'complete', 'aborted')),
  round integer NOT NULL DEFAULT 1,
  replays_this_round integer NOT NULL DEFAULT 0,
  challenger_wins integer NOT NULL DEFAULT 0,
  opponent_wins integer NOT NULL DEFAULT 0,
  -- Snapshotted at duel start so a mid-duel wallet change cannot move the stake.
  challenger_pot_coins integer NOT NULL,
  opponent_pot_coins integer NOT NULL,
  stake_coins integer NOT NULL CHECK (stake_coins >= 0),
  -- Persisted for audit/replay, exactly like hands.deck_seed: the drawn-round tiebreak is
  -- derived deterministically from it.
  tiebreak_seed text NOT NULL,
  outcome text CHECK (outcome IN ('death', 'abort')),
  winner_character_id uuid REFERENCES characters (id) ON DELETE SET NULL,
  loser_character_id uuid REFERENCES characters (id) ON DELETE SET NULL,
  coins_transferred integer,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);

-- Two racing accepts of one invite can therefore only ever produce one duel.
CREATE UNIQUE INDEX ux_duels_invite ON duels (invite_id);
CREATE INDEX ix_duels_challenger ON duels (challenger_id, started_at DESC);
CREATE INDEX ix_duels_opponent ON duels (opponent_id, started_at DESC);

-- Append-only, same shape as hand_actions. The primary key is the idempotency guarantee:
-- one throw per duelist per (round, replay), so a replayed frame cannot throw twice.
CREATE TABLE duel_actions (
  duel_id uuid NOT NULL REFERENCES duels (id) ON DELETE CASCADE,
  round integer NOT NULL,
  replay integer NOT NULL,
  seq integer NOT NULL,
  character_id uuid NOT NULL REFERENCES characters (id) ON DELETE CASCADE,
  throw text NOT NULL CHECK (throw IN ('rock', 'paper', 'scissors')),
  auto_thrown boolean NOT NULL DEFAULT false,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (duel_id, round, replay, character_id)
);
