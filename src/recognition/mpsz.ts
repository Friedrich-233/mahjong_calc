import type { Tile } from '../lib/tile';

// mahjong-calc has `tilesToMpsz` (Tile[] -> string) but no parser for the
// reverse direction, so we add one here. mpsz: digits then a suit letter,
// m/p/s = number suits, z = honors (1..7 = E S W N Haku Hatsu Chun).
// A `0` in m/p/s means a red five.

const SUITS = new Set(['m', 'p', 's', 'z']);

const digitToTile = (type: 'm' | 'p' | 's' | 'z', n: number): Tile | null => {
  if (type === 'z') {
    if (n >= 1 && n <= 4) return { type: 'z', n: n as 1 | 2 | 3 | 4 };
    if (n >= 5 && n <= 7) return { type: 'z', n: n as 5 | 6 | 7 };
    return null;
  }
  if (n === 0) return { type, n: 5, red: true };
  if (n === 5) return { type, n: 5, red: false };
  if (n >= 1 && n <= 9) return { type, n: n as 1 | 2 | 3 | 4 | 6 | 7 | 8 | 9 };
  return null;
};

export const parseMpsz = (input: string): Tile[] => {
  const tiles: Tile[] = [];
  let pending: number[] = [];
  for (const ch of input.toLowerCase()) {
    if (ch >= '0' && ch <= '9') {
      pending.push(Number(ch));
    } else if (SUITS.has(ch)) {
      const type = ch as 'm' | 'p' | 's' | 'z';
      for (const n of pending) {
        const tile = digitToTile(type, n);
        if (tile !== null) tiles.push(tile);
      }
      pending = [];
    }
    // Anything else (spaces, commas, stray characters) is ignored.
  }
  return tiles;
};

// Parse a single tile (e.g. the winning tile). Returns the first tile found.
export const parseMpszTile = (
  input: string | null | undefined
): Tile | null => {
  if (!input) return null;
  return parseMpsz(input)[0] ?? null;
};
