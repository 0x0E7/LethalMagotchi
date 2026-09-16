-- The only change chat itself needs. The predicate every read and write goes through
-- branches on membership, not on kind, so a group channel is already handled everywhere
-- downstream of this constraint.
ALTER TABLE chat_channels DROP CONSTRAINT chat_channels_kind_check;
ALTER TABLE chat_channels
  ADD CONSTRAINT chat_channels_kind_check CHECK (kind IN ('global', 'dm', 'group'));

CREATE TABLE groups (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  -- NFKC-folded and lowercased, the same convention usernames and nicknames use.
  name_normalized text NOT NULL,
  -- Never read as "who is in charge" without the member rows: auto-promotion rewrites it
  -- inside the same transaction that removes the departing leader.
  leader_account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES chat_channels (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Set only when the last member walks away. There is no disband action: no one person
  -- gets a button that ends other people's community.
  archived_at timestamptz
);

CREATE UNIQUE INDEX ux_groups_name_normalized ON groups (name_normalized);
CREATE UNIQUE INDEX ux_groups_channel ON groups (channel_id);

CREATE TABLE group_members (
  group_id uuid NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
  -- Account-scoped, exactly like chat_channel_members, and for chat's own stated reason:
  -- the delete-and-recreate species change must not cost anyone their community.
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  joined_at timestamptz NOT NULL DEFAULT now(),
  -- Soft leave, so the row survives as the history the 24h re-invite cooldown reads.
  left_at timestamptz,
  removed_at timestamptz,
  removed_by uuid REFERENCES accounts (id) ON DELETE SET NULL,
  PRIMARY KEY (group_id, account_id),
  -- A removal is a departure; it can never be recorded on a live membership.
  CHECK (removed_at IS NULL OR left_at IS NOT NULL)
);

-- One group at a time, as a database fact rather than a denormalised column that can drift:
-- two concurrent joins resolve to one membership here, and there is no `active_group_id`
-- for anything to disagree with. Current membership is a query, not a stored answer.
CREATE UNIQUE INDEX ux_group_members_account ON group_members (account_id) WHERE left_at IS NULL;

-- Matches the roster read and the auto-promotion pick: oldest live membership first.
CREATE INDEX ix_group_members_active ON group_members (group_id, joined_at) WHERE left_at IS NULL;

-- The kick cooldown is a query against this history, not a table of its own — the same
-- shape the duel per-pair decline cooldown already has.
CREATE INDEX ix_group_members_removals
  ON group_members (group_id, account_id, removed_at DESC)
  WHERE removed_at IS NOT NULL;

-- The create cooldown reads the same rows the other way round: when did this account last
-- stop being in a group, whichever group that was.
CREATE INDEX ix_group_members_departures
  ON group_members (account_id, left_at DESC)
  WHERE left_at IS NOT NULL;

CREATE TABLE group_invites (
  id uuid PRIMARY KEY,
  group_id uuid NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
  from_account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  to_account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'accepted', 'declined', 'expired', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  resolved_at timestamptz,
  CHECK (from_account_id <> to_account_id)
);

-- One live invitation per person per group, whoever in it issued it.
CREATE UNIQUE INDEX ux_group_invites_pending
  ON group_invites (group_id, to_account_id)
  WHERE state = 'pending';

CREATE INDEX ix_group_invites_to_pending ON group_invites (to_account_id) WHERE state = 'pending';
