-- `active_raid_id` is the third leg of the engagement lock, symmetric with
-- `seated_table_id` and `active_duel_id`: one wallet, one commitment. The raid *target* is
-- deliberately never given one — they are not a participant, and requiring them to be idle
-- would be a consent gate through the back door.
ALTER TABLE characters
  ADD COLUMN active_raid_id uuid,
  -- Rolling 24h from being raided, win or lose, exactly like chicken_badge_until: a
  -- comparison against now(), no cron, no timezone in the model.
  ADD COLUMN raid_immunity_until timestamptz,
  -- The per-raider 6h cooldown, from a raid initiated or joined.
  ADD COLUMN last_raid_at timestamptz;

-- There is deliberately no beggar column: a character IS a beggar exactly while
-- lethal_coins = 0. Derived state has no expiry sweep to leak and no timer to drift.

CREATE TABLE raids (
  id uuid PRIMARY KEY,
  initiator_character_id uuid NOT NULL REFERENCES characters (id) ON DELETE CASCADE,
  target_character_id uuid NOT NULL REFERENCES characters (id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'assembling'
    CHECK (state IN ('assembling', 'resolving', 'betrayal', 'parity', 'complete', 'cancelled')),
  -- Sum of the raiders' whole wallets, escrowed and snapshotted at lock-in.
  raider_pot_coins integer NOT NULL DEFAULT 0 CHECK (raider_pot_coins >= 0),
  -- The target's wallet, read under a row lock at settlement and never trusted from the
  -- band shown at invite time.
  target_pot_coins integer NOT NULL DEFAULT 0 CHECK (target_pot_coins >= 0),
  outcome text CHECK (outcome IN ('raiders_won', 'target_won', 'void')),
  -- True only when every raider betrayed: the one sanctioned place coins leave the economy.
  pot_destroyed boolean NOT NULL DEFAULT false,
  -- Persisted for audit/replay like duels.tiebreak_seed: the capped parity round's
  -- deterministic split is derived from it.
  parity_seed text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  ended_at timestamptz,
  -- When the aftermath report first reached the target, who may have been offline for it.
  aftermath_delivered_at timestamptz,
  CHECK (initiator_character_id <> target_character_id)
);

-- One live raid per target at a time, as a database fact rather than a read-then-write:
-- two parties locking the same player simultaneously resolve to one raid here.
CREATE UNIQUE INDEX ux_raids_live_target
  ON raids (target_character_id)
  WHERE state IN ('assembling', 'resolving', 'betrayal', 'parity');

CREATE INDEX ix_raids_target ON raids (target_character_id, created_at DESC);
CREATE INDEX ix_raids_pending_aftermath
  ON raids (target_character_id)
  WHERE outcome IS NOT NULL AND aftermath_delivered_at IS NULL;

CREATE TABLE raid_members (
  raid_id uuid NOT NULL REFERENCES raids (id) ON DELETE CASCADE,
  character_id uuid NOT NULL REFERENCES characters (id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'invited'
    CHECK (state IN ('invited', 'joined', 'declined', 'expired')),
  is_initiator boolean NOT NULL DEFAULT false,
  -- The whole wallet this raider escrowed; null until lock-in.
  pot_coins_at_lock integer CHECK (pot_coins_at_lock >= 0),
  -- Null until the betrayal phase reveals. There is no betrayal phase unless the raiders
  -- won, so a target win leaves this null for everyone.
  betrayed boolean,
  betrayal_auto boolean NOT NULL DEFAULT false,
  coins_received integer CHECK (coins_received >= 0),
  -- Lost their whole escrow. No death, no rebirth: a raid never touches HP.
  bankrupted_in_raid boolean NOT NULL DEFAULT false,
  invited_at timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  PRIMARY KEY (raid_id, character_id)
);

CREATE INDEX ix_raid_members_character ON raid_members (character_id, raid_id);

-- Append-only, same shape and same guarantee as duel_actions: one call per contender per
-- parity round, so a replayed frame cannot call twice.
CREATE TABLE raid_parity_actions (
  raid_id uuid NOT NULL REFERENCES raids (id) ON DELETE CASCADE,
  round integer NOT NULL,
  seq integer NOT NULL,
  character_id uuid NOT NULL REFERENCES characters (id) ON DELETE CASCADE,
  call text NOT NULL CHECK (call IN ('odds', 'evens')),
  throw integer NOT NULL CHECK (throw BETWEEN 0 AND 5),
  auto_called boolean NOT NULL DEFAULT false,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (raid_id, round, character_id)
);

-- The append-only record of every donation. A donation is its own settlement step — one
-- transaction, both wallets locked in character-id order, debit and credit committed
-- together — so this row is written inside it, never after it.
CREATE TABLE donations (
  id uuid PRIMARY KEY,
  from_character_id uuid NOT NULL REFERENCES characters (id) ON DELETE CASCADE,
  to_character_id uuid NOT NULL REFERENCES characters (id) ON DELETE CASCADE,
  coins integer NOT NULL CHECK (coins >= 1),
  at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_character_id <> to_character_id)
);

CREATE INDEX ix_donations_to ON donations (to_character_id, at DESC);
CREATE INDEX ix_donations_from ON donations (from_character_id, at DESC);
