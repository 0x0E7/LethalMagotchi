import { fileURLToPath } from 'node:url';
import { COUNTRIES, OCCUPATIONS, PERSONALITIES, SHOP_ITEMS, SPECIES } from '@lethalmagotchi/shared';
import { loadConfig } from '../config.js';
import { createPool, type Db } from './pool.js';

export async function seedReferenceData(db: Db): Promise<void> {
  for (const [index, species] of SPECIES.entries()) {
    await db.query(
      `INSERT INTO species (id, display_name, flavor, base_decay_rates, sort_order)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         flavor = EXCLUDED.flavor,
         base_decay_rates = EXCLUDED.base_decay_rates,
         sort_order = EXCLUDED.sort_order`,
      [species.id, species.displayName, species.flavor, JSON.stringify(species.baseDecayRates), index],
    );
  }

  for (const [index, personality] of PERSONALITIES.entries()) {
    await db.query(
      `INSERT INTO personalities (id, display_name, decay_modifiers, sort_order)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         decay_modifiers = EXCLUDED.decay_modifiers,
         sort_order = EXCLUDED.sort_order`,
      [personality.id, personality.displayName, JSON.stringify(personality.decayModifiers), index],
    );
  }

  for (const [index, occupation] of OCCUPATIONS.entries()) {
    await db.query(
      `INSERT INTO occupations (id, display_name, sort_order)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         sort_order = EXCLUDED.sort_order`,
      [occupation.id, occupation.displayName, index],
    );
  }

  for (const [index, item] of SHOP_ITEMS.entries()) {
    await db.query(
      `INSERT INTO shop_items (id, action_id, display_name, cost, effects, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET
         action_id = EXCLUDED.action_id,
         display_name = EXCLUDED.display_name,
         cost = EXCLUDED.cost,
         effects = EXCLUDED.effects,
         sort_order = EXCLUDED.sort_order`,
      [item.id, item.actionId, item.displayName, item.cost, JSON.stringify(item.effects), index],
    );
  }

  for (const country of COUNTRIES) {
    await db.query(
      `INSERT INTO countries (code, display_name)
       VALUES ($1, $2)
       ON CONFLICT (code) DO UPDATE SET display_name = EXCLUDED.display_name`,
      [country.code, country.displayName],
    );
  }
}

const isEntrypoint = process.argv[1] === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  try {
    await seedReferenceData(pool);
    console.log(
      `seeded ${SPECIES.length} species, ${PERSONALITIES.length} personalities, ${OCCUPATIONS.length} occupations, ${SHOP_ITEMS.length} shop items, ${COUNTRIES.length} countries`,
    );
  } finally {
    await pool.end();
  }
}
