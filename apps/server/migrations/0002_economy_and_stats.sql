ALTER TABLE characters
  ADD COLUMN lethal_coins integer NOT NULL DEFAULT 5,
  ADD COLUMN action_cooldowns jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE characters
  ADD CONSTRAINT ck_characters_lethal_coins CHECK (lethal_coins >= 0);

UPDATE characters
SET stats = stats || jsonb_build_object('hp', 100, 'education', 10)
WHERE NOT (stats ? 'hp');

CREATE TABLE shop_items (
  id text PRIMARY KEY,
  action_id text NOT NULL,
  display_name text NOT NULL,
  cost integer NOT NULL CHECK (cost >= 0),
  effects jsonb NOT NULL,
  sort_order integer NOT NULL
);

CREATE INDEX ix_shop_items_action ON shop_items (action_id, sort_order);
