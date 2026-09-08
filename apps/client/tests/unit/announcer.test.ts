import { describe, expect, it } from 'vitest';
import { announcementMatches, distinctAnnouncement } from '../../src/routes/pet/hooks.js';

describe('distinctAnnouncement', () => {
  it('passes new text through unchanged', () => {
    const state = { lastText: '', repeated: false };
    expect(distinctAnnouncement('Kibble. Hunger 60 percent.', state)).toBe('Kibble. Hunger 60 percent.');
  });

  it('appends a zero-width space when the exact same text repeats', () => {
    const state = { lastText: '', repeated: false };
    const first = distinctAnnouncement('Hunger 100 percent.', state);
    const second = distinctAnnouncement('Hunger 100 percent.', state);

    expect(second).not.toBe(first);
    expect(second.startsWith(first)).toBe(true);
    // The visible/read text is unchanged — only a trailing zero-width space differs.
    expect(second.replace(/​+$/u, '')).toBe(first);
  });

  it('keeps alternating on a third, fourth, and fifth identical announcement', () => {
    const state = { lastText: '', repeated: false };
    const seen = new Set<string>();
    let previous = '';
    for (let i = 0; i < 5; i++) {
      const value = distinctAnnouncement('Rest. Energy 100 percent.', state);
      expect(value).not.toBe(previous);
      seen.add(value);
      previous = value;
    }
    // Only ever two distinct rendered forms — it toggles, it doesn't grow unbounded.
    expect(seen.size).toBe(2);
  });

  it('resets the toggle once the text actually changes', () => {
    const state = { lastText: '', repeated: false };
    distinctAnnouncement('Hunger 100 percent.', state);
    const repeat = distinctAnnouncement('Hunger 100 percent.', state);
    expect(repeat).not.toBe('Hunger 100 percent.');

    // A genuinely new message is never suffixed, even right after a repeat.
    const changed = distinctAnnouncement('Mood 80 percent.', state);
    expect(changed).toBe('Mood 80 percent.');

    // And if *that* repeats, it starts the toggle fresh rather than carrying
    // over the previous message's repeat flag.
    const changedRepeat = distinctAnnouncement('Mood 80 percent.', state);
    expect(changedRepeat).not.toBe('Mood 80 percent.');
  });
});

/**
 * The announcer is throttled, so its message lags whatever asked for it. A caller renders the
 * region from this rather than from "is there anything to announce?", which is how a blocked
 * player's words survived their own removal for the length of one throttle window.
 */
describe('announcementMatches', () => {
  it('matches the announcement for the current subject', () => {
    expect(announcementMatches('Alice says hi', 'Alice says hi')).toBe(true);
  });

  it('matches the repeat-forcing variant, which is the same announcement', () => {
    const state = { lastText: '', repeated: false };
    distinctAnnouncement('Alice says hi', state);
    const repeated = distinctAnnouncement('Alice says hi', state);

    expect(repeated).not.toBe('Alice says hi');
    expect(announcementMatches(repeated, 'Alice says hi')).toBe(true);
  });

  it('refuses an announcement left over from a previous subject', () => {
    expect(announcementMatches('Alice says secret', 'Carol says hello')).toBe(false);
  });

  it('refuses everything once there is no subject at all', () => {
    expect(announcementMatches('Alice says secret', null)).toBe(false);
    expect(announcementMatches('', null)).toBe(false);
  });

  it('does not match on a prefix, so a truncated subject cannot pull a longer line through', () => {
    expect(announcementMatches('Alice says secret plans', 'Alice says secret')).toBe(false);
  });
});
