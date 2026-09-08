ALTER TABLE characters
  ADD COLUMN tournament_opt_in boolean NOT NULL DEFAULT false,
  ADD COLUMN tournament_wins integer NOT NULL DEFAULT 0,
  ADD COLUMN seated_table_id uuid,
  ADD COLUMN rebirth_count integer NOT NULL DEFAULT 0,
  ADD COLUMN last_rebirth_at timestamptz;

CREATE TABLE tournaments (
  id uuid PRIMARY KEY,
  scope text NOT NULL DEFAULT 'global',
  state text NOT NULL,
  -- Identifies the schedule slot this row was created for, so a restarted or
  -- double-ticked scheduler can never create the same tournament twice.
  slot_key text NOT NULL,
  scheduled_for timestamptz NOT NULL,
  registration_opens_at timestamptz NOT NULL,
  current_round integer NOT NULL DEFAULT 0,
  total_rounds integer NOT NULL DEFAULT 0,
  entrant_count integer NOT NULL DEFAULT 0,
  prize_pot_coins integer NOT NULL DEFAULT 0,
  shard_index integer NOT NULL DEFAULT 0,
  shard_count integer NOT NULL DEFAULT 1,
  winner_character_id uuid REFERENCES characters (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX ux_tournaments_slot ON tournaments (scope, slot_key, shard_index);
CREATE INDEX ix_tournaments_state_scheduled ON tournaments (state, scheduled_for);

CREATE TABLE tournament_entries (
  tournament_id uuid NOT NULL REFERENCES tournaments (id) ON DELETE CASCADE,
  character_id uuid NOT NULL REFERENCES characters (id) ON DELETE CASCADE,
  hp_converted numeric NOT NULL DEFAULT 0,
  current_stack integer NOT NULL DEFAULT 0 CHECK (current_stack >= 0),
  eliminated_in_round integer,
  final_rank integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tournament_id, character_id)
);

CREATE INDEX ix_tournament_entries_character ON tournament_entries (character_id);

CREATE TABLE tournament_tables (
  id uuid PRIMARY KEY,
  tournament_id uuid NOT NULL REFERENCES tournaments (id) ON DELETE CASCADE,
  round integer NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  hands_played integer NOT NULL DEFAULT 0,
  qualifier_character_id uuid REFERENCES characters (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX ix_tournament_tables_round ON tournament_tables (tournament_id, round);

CREATE TABLE table_seats (
  table_id uuid NOT NULL REFERENCES tournament_tables (id) ON DELETE CASCADE,
  seat_index integer NOT NULL CHECK (seat_index BETWEEN 0 AND 4),
  character_id uuid NOT NULL REFERENCES characters (id) ON DELETE CASCADE,
  stack integer NOT NULL CHECK (stack >= 0),
  starting_stack integer NOT NULL,
  hands_won integer NOT NULL DEFAULT 0,
  connected boolean NOT NULL DEFAULT false,
  PRIMARY KEY (table_id, seat_index)
);

CREATE UNIQUE INDEX ux_table_seats_character ON table_seats (table_id, character_id);

CREATE TABLE hands (
  id uuid PRIMARY KEY,
  table_id uuid NOT NULL REFERENCES tournament_tables (id) ON DELETE CASCADE,
  hand_number integer NOT NULL,
  -- Persisted for audit/replay: the shuffle is derived deterministically from it.
  deck_seed text NOT NULL,
  button_seat integer NOT NULL,
  board text[] NOT NULL DEFAULT '{}',
  street text NOT NULL DEFAULT 'preflop',
  pot_coins integer NOT NULL DEFAULT 0,
  to_act_seat integer,
  action_deadline_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE UNIQUE INDEX ux_hands_table_number ON hands (table_id, hand_number);

CREATE TABLE hand_actions (
  hand_id uuid NOT NULL REFERENCES hands (id) ON DELETE CASCADE,
  seq integer NOT NULL,
  seat_index integer NOT NULL,
  street text NOT NULL,
  action text NOT NULL,
  amount integer NOT NULL DEFAULT 0,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (hand_id, seq)
);

CREATE TABLE rebirth_events (
  id uuid PRIMARY KEY,
  character_id uuid NOT NULL REFERENCES characters (id) ON DELETE CASCADE,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  rebirth_index integer NOT NULL,
  cause text NOT NULL,
  tournament_id uuid REFERENCES tournaments (id) ON DELETE SET NULL,
  stats_before jsonb NOT NULL,
  coins_before integer NOT NULL
);

CREATE INDEX ix_rebirth_events_character ON rebirth_events (character_id, occurred_at DESC);
