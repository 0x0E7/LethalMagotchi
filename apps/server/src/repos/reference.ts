import type {
  Country,
  DecayRates,
  Occupation,
  OccupationId,
  Personality,
  PersonalityId,
  PickerActionId,
  ReferenceResponse,
  ShopItem,
  ShopItemId,
  Species,
  SpeciesId,
  StatEffect,
  StatKey,
} from '@lethalmagotchi/shared';
import { REFERENCE_VERSION } from '@lethalmagotchi/shared';
import type { Db } from '../db/pool.js';

export async function loadReference(db: Db): Promise<ReferenceResponse> {
  const [species, personalities, occupations, shopItems, countries] = await Promise.all([
    db.query<{ id: SpeciesId; display_name: string; flavor: string; base_decay_rates: DecayRates }>(
      'SELECT id, display_name, flavor, base_decay_rates FROM species ORDER BY sort_order',
    ),
    db.query<{
      id: PersonalityId;
      display_name: string;
      decay_modifiers: Partial<Record<StatKey, number>>;
    }>('SELECT id, display_name, decay_modifiers FROM personalities ORDER BY sort_order'),
    db.query<{ id: OccupationId; display_name: string }>(
      'SELECT id, display_name FROM occupations ORDER BY sort_order',
    ),
    db.query<{
      id: ShopItemId;
      action_id: PickerActionId;
      display_name: string;
      cost: number;
      effects: StatEffect[];
    }>('SELECT id, action_id, display_name, cost, effects FROM shop_items ORDER BY sort_order'),
    db.query<{ code: string; display_name: string }>(
      'SELECT code, display_name FROM countries ORDER BY display_name',
    ),
  ]);

  return {
    version: REFERENCE_VERSION,
    species: species.rows.map(
      (row): Species => ({
        id: row.id,
        displayName: row.display_name,
        flavor: row.flavor,
        baseDecayRates: row.base_decay_rates,
      }),
    ),
    personalities: personalities.rows.map(
      (row): Personality => ({
        id: row.id,
        displayName: row.display_name,
        decayModifiers: row.decay_modifiers,
      }),
    ),
    occupations: occupations.rows.map(
      (row): Occupation => ({ id: row.id, displayName: row.display_name }),
    ),
    countries: countries.rows.map((row): Country => ({ code: row.code, displayName: row.display_name })),
    shopItems: shopItems.rows.map(
      (row): ShopItem => ({
        id: row.id,
        actionId: row.action_id,
        displayName: row.display_name,
        cost: row.cost,
        effects: row.effects,
      }),
    ),
  };
}
