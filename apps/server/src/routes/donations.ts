import type { FastifyInstance } from 'fastify';
import {
  DONATION_APPEAL_COOLDOWN_MS,
  TOWN_SQUARE_CHANNEL_ID,
  donationAppealBody,
  donationSchema,
  isBeggarWallet,
  type AppealResponse,
  type DonationResponse,
} from '@lethalmagotchi/shared';
import { withTransaction } from '../db/pool.js';
import type { ServerDeps } from '../deps.js';
import { ApiError } from '../errors.js';
import {
  claimDonationAppeal,
  creditCoins,
  findActiveCharacterByAccount,
  lockCharacterById,
  toCharacterDto,
} from '../repos/characters.js';
import { insertSystemMessage } from '../repos/chat.js';
import { insertDonation, toDonationDto } from '../repos/donations.js';
import { parseOrThrow } from '../validate.js';
import { uuidv7 } from '../uuid.js';

/**
 * Giving, and asking. Both are low-frequency, so both go over HTTP rather than adding a
 * message to the socket protocol: the appeal surfaces through the Town Square system line
 * chat already broadcasts, and a received donation reaches the recipient through the
 * `character:update` frame every other wallet change already uses.
 */
export async function registerDonationRoutes(app: FastifyInstance, deps: ServerDeps): Promise<void> {
  const { db, hub, chat, limiters } = deps;

  app.post('/api/v1/donations', { onRequest: app.authenticate }, async (request, reply) => {
    /**
     * Charged before the body is looked at, in the order chat settled on: a donation that
     * was never going to land must cost the same budget as one that does.
     */
    const flood = limiters.donation.check(request.accountId);
    if (!flood.allowed) {
      throw new ApiError(429, 'RATE_LIMITED', 'Slow down a moment.', {
        retryAfterSeconds: flood.retryAfterSeconds,
      });
    }

    const { toCharacterId, coins } = parseOrThrow(donationSchema, request.body);
    const sender = await findActiveCharacterByAccount(db, request.accountId);
    if (!sender) throw new ApiError(404, 'NO_CHARACTER', 'You do not have a character yet.');
    if (sender.id === toCharacterId) {
      throw new ApiError(422, 'SELF_DONATION', 'You cannot donate to yourself.');
    }

    const at = new Date();
    const payload = await withTransaction(db, async (client) => {
      /**
       * Both wallets locked in character-id order, like every other multi-character write
       * here: a donation is its own settlement step, so the debit, the credit and the
       * append-only row commit together or not at all.
       */
      const [first, second] = [sender.id, toCharacterId].sort();
      const rows = new Map<string, Awaited<ReturnType<typeof lockCharacterById>>>();
      for (const id of [first!, second!]) rows.set(id, await lockCharacterById(client, id));

      const from = rows.get(sender.id);
      const to = rows.get(toCharacterId);
      if (!from) throw new ApiError(404, 'NO_CHARACTER', 'You do not have a character yet.');
      if (!to || !to.account_id) throw new ApiError(404, 'NOT_FOUND', 'That player is no longer around.');
      /**
       * A different *account*, not merely a different character: an alt could otherwise
       * launder coins around every wealth cap the rest of the economy enforces.
       */
      if (to.account_id === request.accountId) {
        throw new ApiError(422, 'SELF_DONATION', 'You cannot donate to your own account.');
      }
      /**
       * Re-read under the lock, which is what makes a bankruptcy rescuable exactly once: two
       * donations racing each other both reach here, and the second finds a recipient who is
       * no longer a beggar.
       */
      if (!isBeggarWallet(to.lethal_coins, to.active_raid_id)) {
        throw new ApiError(
          409,
          'NOT_A_BEGGAR',
          to.active_raid_id
            ? 'Their coins are staked in a raid right now.'
            : 'They are not begging any more.',
        );
      }
      if (from.lethal_coins < coins) {
        throw new ApiError(402, 'INSUFFICIENT_FUNDS', `You only have ${from.lethal_coins} LethalCoins.`);
      }
      // The sender's own commitments are real coins elsewhere; they cannot also be given away.
      if (from.seated_table_id) throw new ApiError(409, 'CHARACTER_SEATED', 'You are at a table right now.');
      if (from.active_duel_id) throw new ApiError(409, 'CHARACTER_IN_DUEL', 'You are in a duel right now.');
      if (from.active_raid_id) throw new ApiError(409, 'CHARACTER_IN_RAID', 'You are in a raid right now.');

      const debited = await creditCoins(client, sender.id, -coins);
      const credited = await creditCoins(client, toCharacterId, coins);
      const donation = await insertDonation(client, {
        id: uuidv7(),
        fromCharacterId: sender.id,
        toCharacterId,
        coins,
        at,
      });

      return {
        body: { donation: toDonationDto(donation), character: toCharacterDto(debited, at.getTime()) },
        recipient: credited,
      };
    });

    // The first coin lifts the beggar state, so the recipient's own wallet frame is how they
    // find out they were rescued.
    hub.sendToCharacter(toCharacterId, {
      type: 'character:update',
      character: toCharacterDto(payload.recipient, at.getTime()),
    });

    const body: DonationResponse = payload.body;
    return reply.code(201).send(body);
  });

  app.post('/api/v1/appeals', { onRequest: app.authenticate }, async (request, reply) => {
    const character = await findActiveCharacterByAccount(db, request.accountId);
    if (!character) throw new ApiError(404, 'NO_CHARACTER', 'You do not have a character yet.');

    const at = new Date();
    const notBefore = new Date(at.getTime() - DONATION_APPEAL_COOLDOWN_MS);
    /**
     * The floor lives on the row, like every other raid-side floor: an in-process window
     * resets on each deploy and is not shared between instances, which for a floor that
     * exists to keep the Town Square quiet is the difference between a rule and a hint.
     */
    if (character.last_donation_appeal_at && character.last_donation_appeal_at > notBefore) {
      throw new ApiError(429, 'RATE_LIMITED', appealRetryMessage(character.last_donation_appeal_at, at), {
        retryAfterSeconds: retryAfterSeconds(character.last_donation_appeal_at, at),
      });
    }
    // Only somebody with nothing may ask, and the ask is refused the moment they hold a coin.
    if (!isBeggarWallet(character.lethal_coins, character.active_raid_id)) {
      throw new ApiError(
        409,
        'NOT_A_BEGGAR',
        character.active_raid_id ? 'Your coins are staked in a raid right now.' : 'You still have coins.',
      );
    }

    const message = await withTransaction(db, async (client) => {
      // Re-read as part of the write: two appeals racing each other both cleared the check
      // above, and only the one that wins this claim may post.
      const claimed = await claimDonationAppeal(client, character.id, { at, notBefore });
      if (!claimed) return null;
      return insertSystemMessage(client, {
        channelId: TOWN_SQUARE_CHANNEL_ID,
        body: donationAppealBody(character.nickname),
        at,
      });
    });
    if (!message) {
      throw new ApiError(429, 'RATE_LIMITED', 'You have already asked recently.', {
        retryAfterSeconds: Math.ceil(DONATION_APPEAL_COOLDOWN_MS / 1_000),
      });
    }
    chat.broadcastSystemMessage(TOWN_SQUARE_CHANNEL_ID, message);

    const body: AppealResponse = { postedAt: at.toISOString() };
    return reply.code(201).send(body);
  });
}

function retryAfterSeconds(lastAppealAt: Date, now: Date): number {
  const remaining = lastAppealAt.getTime() + DONATION_APPEAL_COOLDOWN_MS - now.getTime();
  return Math.max(1, Math.ceil(remaining / 1_000));
}

function appealRetryMessage(lastAppealAt: Date, now: Date): string {
  return `You can ask again in ${Math.ceil(retryAfterSeconds(lastAppealAt, now) / 60)} minutes.`;
}
