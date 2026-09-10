-- The Stakes Card's number has to be the number that gets played for. Snapshotting it on
-- the invite makes the challenger's advertised stake a fact the accept path reads back,
-- rather than a re-derivation from a wallet that may have moved during the 60s window.
ALTER TABLE duel_invites
  ADD COLUMN stake_coins integer NOT NULL DEFAULT 0 CHECK (stake_coins >= 0);

-- The spend guard reads this on every paid action, so it has to be an index hit.
CREATE INDEX ix_duel_invites_from_pending ON duel_invites (from_character_id) WHERE state = 'pending';
