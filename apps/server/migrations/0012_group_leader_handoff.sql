-- A leader's account disappearing must be a handoff, not an ending: `ON DELETE CASCADE`
-- deleted the whole group out from under its other members while leaving the chat channel
-- orphaned and unleavable. This is the same shape `chat_channels.created_by` already settled
-- with `ON DELETE SET NULL` — a room outlives whoever opened it — and it matches the
-- auto-promotion that already runs when a leader voluntarily leaves. A NULL leader is read
-- as "leaderless, promote the longest-standing member", which the group read paths do.
ALTER TABLE groups DROP CONSTRAINT groups_leader_account_id_fkey;
ALTER TABLE groups ALTER COLUMN leader_account_id DROP NOT NULL;
ALTER TABLE groups
  ADD CONSTRAINT groups_leader_account_id_fkey
  FOREIGN KEY (leader_account_id) REFERENCES accounts (id) ON DELETE SET NULL;
