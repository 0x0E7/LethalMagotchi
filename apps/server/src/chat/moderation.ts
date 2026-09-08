import { classifyMessage, type ModerationDisposition } from '@lethalmagotchi/shared';

/**
 * A moderation hiccup must never take chat down, so the check is given a hard deadline and
 * a fail-open answer. Failing open to `flagged` rather than `clean` keeps the record honest:
 * "we did not manage to look at this one" and "we looked and it was fine" are not the same
 * thing, and only the first should be revisited once there is a review surface.
 */
export const MODERATION_TIMEOUT_MS = 250;
export const MODERATION_FAIL_OPEN: ModerationDisposition = 'flagged';

export type Classifier = (body: string) => ModerationDisposition | Promise<ModerationDisposition>;

export interface ScreenOptions {
  classify?: Classifier;
  timeoutMs?: number;
  onFailure?: (error: unknown) => void;
}

export async function screenMessage(
  body: string,
  options: ScreenOptions = {},
): Promise<ModerationDisposition> {
  const classify = options.classify ?? classifyMessage;
  const timeoutMs = options.timeoutMs ?? MODERATION_TIMEOUT_MS;

  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const verdict = await Promise.race([
      Promise.resolve().then(() => classify(body)),
      new Promise<ModerationDisposition>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('moderation timed out')), timeoutMs);
        timer.unref?.();
      }),
    ]);
    return verdict;
  } catch (error) {
    options.onFailure?.(error);
    return MODERATION_FAIL_OPEN;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
