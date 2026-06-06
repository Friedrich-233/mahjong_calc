import { type Input, type Meld, instantiateMeld } from '../lib/input';
import type { Rule } from '../lib/rule';
import {
  type NumberTile,
  type Tile,
  compareTiles,
  tileToCountsIndex
} from '../lib/tile';
import { parseMpsz, parseMpszTile } from './mpsz';
import type { RecognitionResult, RecognizedMeld } from './types';

export interface AdapterResult {
  input: Input;
  warnings: string[];
}

type NumberSuit = 'm' | 'p' | 's';
const NUMBER_SUITS: NumberSuit[] = ['m', 'p', 's'];
// The red-five shape (the n:5 member of NumberTile); used when flipping reds.
type FiveTile = { type: NumberSuit; n: 5; red: boolean };

const isRedFive = (t: Tile): boolean => t.type !== 'z' && t.n === 5 && t.red;

const sameTile = (a: Tile, b: Tile, withRed: boolean): boolean =>
  a.type === b.type &&
  a.n === b.n &&
  (!withRed || a.type === 'z' || a.n !== 5 || isRedFive(a) === isRedFive(b));

// Build a mahjong-calc Meld from a recognized meld. Returns null when the tiles
// can't form a meld (so we skip it rather than crash). For chii we keep only the
// lowest tile + an `includeRed` flag, exactly as the app's own state does.
const buildMeld = (m: RecognizedMeld): Meld | null => {
  const tiles = parseMpsz(m.tiles ?? '');
  if (tiles.length === 0) return null;
  const type = m.type === 'chi' ? 'chii' : m.type;

  if (type === 'chii') {
    const numbers = tiles.filter((t): t is NumberTile => t.type !== 'z');
    if (numbers.length === 0) return null;
    const lowest = numbers.reduce((a, b) => (a.n <= b.n ? a : b));
    if (lowest.n >= 8) return null; // can't start a run at 8 or 9
    const fiveRed = numbers.some(t => t.n === 5 && t.red);
    if (lowest.n === 5) {
      // 567 run: the red five (if any) is the base tile itself.
      return {
        type: 'chii',
        tile: { type: lowest.type, n: 5, red: fiveRed },
        includeRed: false
      };
    }
    return {
      type: 'chii',
      tile: { type: lowest.type, n: lowest.n } as NumberTile,
      includeRed: fiveRed // only meaningful for 345 / 456 runs
    };
  }

  if (type === 'pon') {
    const base = tiles[0] as Tile;
    const red = tiles.some(t => t.type !== 'z' && t.n === 5 && t.red);
    const tile: Tile =
      base.type !== 'z' && base.n === 5 ? { ...base, red } : base;
    return { type: 'pon', tile };
  }

  if (type === 'kan') {
    // Default to an open kan; a concealed kan can be toggled in the existing UI.
    return { type: 'kan', tile: tiles[0] as Tile, closed: false };
  }

  return null;
};

const countRedFivesBySuit = (tiles: Tile[]): Record<NumberSuit, number> => {
  const out: Record<NumberSuit, number> = { m: 0, p: 0, s: 0 };
  for (const t of tiles) {
    if (t.type !== 'z' && t.n === 5 && t.red) out[t.type] += 1;
  }
  return out;
};

const akaCountBySuit = (aka: string[]): Record<NumberSuit, number> => {
  const out: Record<NumberSuit, number> = { m: 0, p: 0, s: 0 };
  for (const entry of aka ?? []) {
    const s = String(entry).toLowerCase();
    for (const suit of NUMBER_SUITS) {
      if (s.includes(suit)) out[suit] += 1;
    }
  }
  return out;
};

export const recognitionToInput = (
  result: RecognitionResult,
  red: Rule['red']
): AdapterResult => {
  const warnings: string[] = [];

  // 1. Build melds (max 4), dropping any that can't be formed.
  const rawMelds = Array.isArray(result.melds) ? result.melds : [];
  const melds: Meld[] = [];
  for (const rm of rawMelds.slice(0, 4)) {
    const meld = buildMeld(rm);
    if (meld === null)
      warnings.push(`Skipped an unreadable meld: "${rm.tiles ?? ''}".`);
    else melds.push(meld);
  }
  const meldTiles = melds.flatMap(m => instantiateMeld(m, red));

  // 2. Parse the concealed tiles.
  const concealed = parseMpsz(result.concealed ?? '');

  // 3. Reconcile red fives. The mpsz `0` digits are primary; the `aka` array is
  //    a secondary hint. Cap each suit's concealed reds by what the rule allows
  //    after accounting for reds already inside the melds.
  const meldReds = countRedFivesBySuit(meldTiles);
  const parsedReds = countRedFivesBySuit(concealed);
  const akaReds = akaCountBySuit(result.aka ?? []);
  for (const suit of NUMBER_SUITS) {
    const fives = concealed.filter(
      (t): t is FiveTile => t.type === suit && t.n === 5
    );
    const want = Math.min(
      Math.max(parsedReds[suit], akaReds[suit]),
      Math.max(0, red[suit] - meldReds[suit]),
      fives.length
    );
    fives.forEach((tile, i) => {
      tile.red = i < want;
    });
  }

  // 4. Build the hand: sorted, with the winning tile kept LAST (the app's
  //    convention for the agari tile), clamped to <=4 of any tile and to the
  //    remaining hand size so scoring never throws.
  const limit = 14 - melds.length * 3;
  const counts = Array<number>(34).fill(0);
  for (const t of meldTiles) {
    const i = tileToCountsIndex(t);
    counts[i] = (counts[i] ?? 0) + 1;
  }

  const hand: Tile[] = [];
  let dropped = 0;
  const tryAdd = (t: Tile): boolean => {
    const idx = tileToCountsIndex(t);
    const current = counts[idx] ?? 0;
    if (hand.length >= limit || current >= 4) return false;
    counts[idx] = current + 1;
    hand.push(t);
    return true;
  };

  const winning = parseMpszTile(result.winning_tile);
  const rest = [...concealed];
  let winningToAppend: Tile | null = null;
  if (winning !== null) {
    let idx = rest.findIndex(t => sameTile(t, winning, true));
    if (idx < 0) idx = rest.findIndex(t => sameTile(t, winning, false));
    if (idx >= 0) {
      winningToAppend = rest[idx] as Tile;
      rest.splice(idx, 1);
    } else {
      winningToAppend = winning; // model omitted it from concealed; still the agari
    }
  }

  rest.sort(compareTiles);
  for (const t of rest) if (!tryAdd(t)) dropped += 1;
  if (winningToAppend !== null && !tryAdd(winningToAppend)) dropped += 1;
  if (dropped > 0) {
    warnings.push(
      `${dropped} extra tile(s) were dropped (over 4-of-a-kind or too many tiles).`
    );
  }

  return { input: { hand, melds, dora: [] }, warnings };
};
