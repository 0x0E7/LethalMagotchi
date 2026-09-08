export const BLACKOUT_TZ = 'Asia/Jerusalem';

/** Israel-local buckets. Tournaments are off outside [10:00, 18:00) local. */
export const SLOT_BUCKETS: [number, number][] = [
  [10, 14],
  [14, 18],
];

export const ACTIVE_WINDOW_START_HOUR = SLOT_BUCKETS[0]![0];
export const ACTIVE_WINDOW_END_HOUR = SLOT_BUCKETS[SLOT_BUCKETS.length - 1]![1];

const MS_PER_DAY = 86_400_000;

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const partFormatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let formatter = partFormatters.get(tz);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    partFormatters.set(tz, formatter);
  }
  return formatter;
}

export function zonedParts(tz: string, at: Date): ZonedParts {
  const parts = formatterFor(tz).formatToParts(at);
  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)!.value);
  // en-GB renders midnight as "24" in some ICU versions; normalise it to 0.
  const hour = read('hour') % 24;
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour,
    minute: read('minute'),
    second: read('second'),
  };
}

export function localHourIn(tz: string, at: Date): number {
  return zonedParts(tz, at).hour;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

export function localDateIn(tz: string, at: Date): string {
  const parts = zonedParts(tz, at);
  return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}`;
}

function offsetMsAt(tz: string, at: Date): number {
  const parts = zonedParts(tz, at);
  const asIfUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asIfUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * Israel observes DST, so a wall-clock time cannot be converted with a fixed offset.
 * Two fixed-point passes over ICU's own offset converge for every real transition
 * (the second pass corrects a guess that landed on the wrong side of a shift).
 */
export function zonedTimeToUtc(
  tz: string,
  localDate: string,
  hour: number,
  minute = 0,
  second = 0,
): Date {
  const [year, month, day] = localDate.split('-').map(Number) as [number, number, number];
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  let timestamp = wall;
  for (let pass = 0; pass < 2; pass += 1) {
    timestamp = wall - offsetMsAt(tz, new Date(timestamp));
  }
  return new Date(timestamp);
}

/** FNV-1a. Deterministic across processes and platforms, which is the whole requirement. */
export function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function mix(seed: number): number {
  let value = (seed + 0x9e3779b9) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x21f0aaad) >>> 0;
  value = Math.imul(value ^ (value >>> 15), 0x735a2d97) >>> 0;
  return (value ^ (value >>> 15)) >>> 0;
}

/**
 * One random-looking instant per 4-hour bucket, derived from the Israel-local date so
 * every server instance and LAN host agrees without coordinating. Minute granularity
 * keeps the countdown readable; the exact minute is still unpredictable to players.
 */
export function dailySlots(localDate: string, tz: string = BLACKOUT_TZ): Date[] {
  return SLOT_BUCKETS.map(([startHour, endHour], index) => {
    const spanMinutes = (endHour - startHour) * 60;
    const offsetMinutes = mix(hashString(localDate) + index) % spanMinutes;
    return zonedTimeToUtc(tz, localDate, startHour, offsetMinutes);
  });
}

export function isBlackout(at: Date, tz: string = BLACKOUT_TZ): boolean {
  const hour = localHourIn(tz, at);
  return hour < ACTIVE_WINDOW_START_HOUR || hour >= ACTIVE_WINDOW_END_HOUR;
}

/** The next Israel-local 10:00, for the blackout chip's "Tournaments resume" label. */
export function activeWindowOpensAfter(at: Date, tz: string = BLACKOUT_TZ): Date {
  const today = zonedTimeToUtc(tz, localDateIn(tz, at), ACTIVE_WINDOW_START_HOUR);
  if (today.getTime() > at.getTime()) return today;
  const tomorrow = localDateIn(tz, new Date(at.getTime() + MS_PER_DAY));
  return zonedTimeToUtc(tz, tomorrow, ACTIVE_WINDOW_START_HOUR);
}

export function nextSlotAfter(at: Date, tz: string = BLACKOUT_TZ): Date {
  for (let dayOffset = 0; dayOffset <= 2; dayOffset += 1) {
    const localDate = localDateIn(tz, new Date(at.getTime() + dayOffset * MS_PER_DAY));
    for (const slot of dailySlots(localDate, tz)) {
      if (slot.getTime() > at.getTime()) return slot;
    }
  }
  // Unreachable for any real clock: day+2's first slot is always in the future.
  return activeWindowOpensAfter(at, tz);
}
