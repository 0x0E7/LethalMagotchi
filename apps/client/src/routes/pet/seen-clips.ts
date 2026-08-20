import type { ClipId } from '@lethalmagotchi/shared';

const STORAGE_KEY = 'lm.seen-clips.v1';

type SeenMap = Record<string, string[]>;

function load(): SeenMap {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const map: SeenMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(value)) map[key] = value.filter((entry): entry is string => typeof entry === 'string');
    }
    return map;
  } catch {
    return {};
  }
}

export function hasSeenClip(characterId: string, clipId: ClipId): boolean {
  return load()[characterId]?.includes(clipId) ?? false;
}

export function markClipSeen(characterId: string, clipId: ClipId): void {
  try {
    const map = load();
    const seen = map[characterId] ?? [];
    if (seen.includes(clipId)) return;
    map[characterId] = [...seen, clipId];
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Storage can be unavailable (private mode / quota); re-seeing a clip is harmless.
  }
}
