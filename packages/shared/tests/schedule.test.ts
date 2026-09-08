import { describe, expect, it } from 'vitest';
import {
  ACTIVE_WINDOW_END_HOUR,
  ACTIVE_WINDOW_START_HOUR,
  BLACKOUT_TZ,
  activeWindowOpensAfter,
  dailySlots,
  isBlackout,
  localDateIn,
  localHourIn,
  nextSlotAfter,
  zonedTimeToUtc,
} from '../src/schedule.js';

describe('zoned conversion', () => {
  it('resolves winter (UTC+2) and summer (UTC+3) wall clocks correctly', () => {
    expect(zonedTimeToUtc(BLACKOUT_TZ, '2026-01-15', 10).toISOString()).toBe('2026-01-15T08:00:00.000Z');
    expect(zonedTimeToUtc(BLACKOUT_TZ, '2026-07-15', 10).toISOString()).toBe('2026-07-15T07:00:00.000Z');
  });

  it('handles the spring-forward and fall-back days', () => {
    // Israel springs forward on the Friday before the last Sunday of March, and falls
    // back on the last Sunday of October — both inside the active window's own dates.
    expect(zonedTimeToUtc(BLACKOUT_TZ, '2026-03-27', 10).toISOString()).toBe('2026-03-27T07:00:00.000Z');
    expect(zonedTimeToUtc(BLACKOUT_TZ, '2026-03-26', 10).toISOString()).toBe('2026-03-26T08:00:00.000Z');
    expect(zonedTimeToUtc(BLACKOUT_TZ, '2026-10-25', 10).toISOString()).toBe('2026-10-25T08:00:00.000Z');
    expect(zonedTimeToUtc(BLACKOUT_TZ, '2026-10-24', 10).toISOString()).toBe('2026-10-24T07:00:00.000Z');
  });

  it('round-trips a wall clock through the local-hour reader', () => {
    for (const date of ['2026-01-15', '2026-07-15', '2026-03-27', '2026-10-25']) {
      for (const hour of [10, 13, 17]) {
        const instant = zonedTimeToUtc(BLACKOUT_TZ, date, hour);
        expect(localHourIn(BLACKOUT_TZ, instant)).toBe(hour);
        expect(localDateIn(BLACKOUT_TZ, instant)).toBe(date);
      }
    }
  });
});

describe('daily slots', () => {
  it('is deterministic for a given local date', () => {
    expect(dailySlots('2026-08-20').map((slot) => slot.toISOString())).toEqual(
      dailySlots('2026-08-20').map((slot) => slot.toISOString()),
    );
  });

  it('differs between days', () => {
    expect(dailySlots('2026-08-20')[0]!.getTime()).not.toBe(dailySlots('2026-08-21')[0]!.getTime());
  });

  it('places both slots inside their own bucket, in order, and never in blackout', () => {
    for (let day = 1; day <= 28; day += 1) {
      for (const month of ['01', '03', '07', '10']) {
        const date = `2026-${month}-${String(day).padStart(2, '0')}`;
        const [first, second] = dailySlots(date) as [Date, Date];

        expect(localHourIn(BLACKOUT_TZ, first)).toBeGreaterThanOrEqual(10);
        expect(localHourIn(BLACKOUT_TZ, first)).toBeLessThan(14);
        expect(localHourIn(BLACKOUT_TZ, second)).toBeGreaterThanOrEqual(14);
        expect(localHourIn(BLACKOUT_TZ, second)).toBeLessThan(18);
        expect(second.getTime()).toBeGreaterThan(first.getTime());
        expect(isBlackout(first)).toBe(false);
        expect(isBlackout(second)).toBe(false);
        expect(localDateIn(BLACKOUT_TZ, first)).toBe(date);
        expect(localDateIn(BLACKOUT_TZ, second)).toBe(date);
      }
    }
  });

  it('lands on a whole minute', () => {
    for (const slot of dailySlots('2026-08-20')) {
      expect(slot.getUTCSeconds()).toBe(0);
      expect(slot.getUTCMilliseconds()).toBe(0);
    }
  });
});

describe('blackout window', () => {
  it('is closed outside 10:00-18:00 Israel time', () => {
    expect(isBlackout(zonedTimeToUtc(BLACKOUT_TZ, '2026-08-20', 9, 59))).toBe(true);
    expect(isBlackout(zonedTimeToUtc(BLACKOUT_TZ, '2026-08-20', ACTIVE_WINDOW_START_HOUR))).toBe(false);
    expect(isBlackout(zonedTimeToUtc(BLACKOUT_TZ, '2026-08-20', 17, 59))).toBe(false);
    expect(isBlackout(zonedTimeToUtc(BLACKOUT_TZ, '2026-08-20', ACTIVE_WINDOW_END_HOUR))).toBe(true);
    expect(isBlackout(zonedTimeToUtc(BLACKOUT_TZ, '2026-08-20', 3))).toBe(true);
  });

  it('reports the next 10:00 local as the resume time', () => {
    const evening = zonedTimeToUtc(BLACKOUT_TZ, '2026-08-20', 20);
    expect(activeWindowOpensAfter(evening).toISOString()).toBe(
      zonedTimeToUtc(BLACKOUT_TZ, '2026-08-21', 10).toISOString(),
    );

    const earlyMorning = zonedTimeToUtc(BLACKOUT_TZ, '2026-08-20', 6);
    expect(activeWindowOpensAfter(earlyMorning).toISOString()).toBe(
      zonedTimeToUtc(BLACKOUT_TZ, '2026-08-20', 10).toISOString(),
    );
  });
});

describe('next slot', () => {
  it('always returns a future instant that is one of the day slots', () => {
    for (const at of [
      zonedTimeToUtc(BLACKOUT_TZ, '2026-08-20', 3),
      zonedTimeToUtc(BLACKOUT_TZ, '2026-08-20', 12),
      zonedTimeToUtc(BLACKOUT_TZ, '2026-08-20', 17, 59),
      zonedTimeToUtc(BLACKOUT_TZ, '2026-08-20', 23, 30),
    ]) {
      const next = nextSlotAfter(at);
      expect(next.getTime()).toBeGreaterThan(at.getTime());
      const candidates = [
        ...dailySlots(localDateIn(BLACKOUT_TZ, at)),
        ...dailySlots(localDateIn(BLACKOUT_TZ, new Date(at.getTime() + 86_400_000))),
      ].map((slot) => slot.toISOString());
      expect(candidates).toContain(next.toISOString());
    }
  });

  it('rolls to tomorrow once the day is spent', () => {
    const late = zonedTimeToUtc(BLACKOUT_TZ, '2026-08-20', 23, 30);
    expect(localDateIn(BLACKOUT_TZ, nextSlotAfter(late))).toBe('2026-08-21');
  });
});
