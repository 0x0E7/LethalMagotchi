-- Registration close and round advance are both single-writer operations that were
-- previously guarded only by reading state back. These two claims make them atomic.

ALTER TABLE tournaments ADD COLUMN registration_closed_at timestamptz;

CREATE TABLE tournament_charges (
  tournament_id uuid NOT NULL REFERENCES tournaments (id) ON DELETE CASCADE,
  character_id uuid NOT NULL REFERENCES characters (id) ON DELETE CASCADE,
  charge text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tournament_id, character_id)
);
