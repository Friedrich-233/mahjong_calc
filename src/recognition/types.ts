// The intermediate contract returned by POST /api/recognize. The vision model
// is asked to emit exactly this shape (see the system prompt in server/index.ts).
// `adapter.ts` converts it into mahjong-calc's internal Input state.

export interface RecognizedMeld {
  // The model is told to use "chi"; we also accept the app's spelling "chii".
  type: 'chi' | 'chii' | 'pon' | 'kan';
  tiles: string; // mpsz, e.g. "789p"
  // Which player it was called from. Irrelevant to scoring — accepted but unused.
  from?: 'left' | 'across' | 'right' | null;
}

export interface RecognitionResult {
  concealed: string; // mpsz of concealed tiles, including the winning tile
  melds: RecognizedMeld[];
  winning_tile: string | null; // a single tile in mpsz, or null
  aka: string[]; // red fives flagged separately, e.g. ["0m", "0p"]
}
