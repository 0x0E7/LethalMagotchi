-- The aftermath report is the only notification a bankrupted, offline victim ever gets, so
-- it is kept until the client says it was shown rather than until a send was attempted: a
-- socket that drops mid-delivery must cost a reconnect, not the report. The column is the
-- same one, renamed to say what it now records.
ALTER TABLE raids RENAME COLUMN aftermath_delivered_at TO aftermath_acked_at;

-- The donation appeal's 3h floor, moved off the in-process rate limiter and onto the row it
-- belongs to, like every other raid-side floor (raid_immunity_until, last_raid_at): an
-- in-memory window resets on every deploy and is not shared between instances.
ALTER TABLE characters ADD COLUMN last_donation_appeal_at timestamptz;
