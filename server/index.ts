import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

// ---------------------------------------------------------------------------
// Roboflow-only backend for mahjong-calc:
//   * POST /api/recognize  - send a photo to a Roboflow YOLO model
//   * GET  /api/health     - quick configuration probe
//   * everything else      - serve the built frontend with SPA fallback
//
// The Roboflow API key stays on the server. The browser only calls /api.
// ---------------------------------------------------------------------------

const {
  PORT,
  DIST_DIR,
  ROBOFLOW_API_KEY,
  ROBOFLOW_BASE_URL,
  ROBOFLOW_MODEL,
  ROBOFLOW_CONFIDENCE,
  ROBOFLOW_OVERLAP,
  ROBOFLOW_DEDUP_IOU
} = process.env;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(PORT) || 5173;
const distDir = DIST_DIR || path.resolve(__dirname, '..', 'dist');

const roboflowBaseUrl =
  ROBOFLOW_BASE_URL?.replace(/\/+$/, '') || 'https://serverless.roboflow.com';
const roboflowModel =
  ROBOFLOW_MODEL?.replace(/^\/+/, '') || 'majiang-z3y6n/1';

const parseNumber = (value: string | undefined, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const roboflowConfidence = clamp(
  Math.round(parseNumber(ROBOFLOW_CONFIDENCE, 30)),
  0,
  100
);
const roboflowOverlap = clamp(
  Math.round(parseNumber(ROBOFLOW_OVERLAP, 30)),
  0,
  100
);
const dedupeIou = clamp(parseNumber(ROBOFLOW_DEDUP_IOU, 0.55), 0, 1);

interface RoboflowPrediction {
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
  class: string;
}

interface DetectedTile extends RoboflowPrediction {
  tile: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object';

const dataUrlToBase64 = (image: string): string =>
  image
    .replace(/^data:[^,]*,/, '')
    .replace(/\s/g, '')
    .trim();

const roboflowEndpoint = (): string => {
  const url = new URL(`${roboflowBaseUrl}/${roboflowModel}`);
  url.searchParams.set('api_key', ROBOFLOW_API_KEY ?? '');
  url.searchParams.set('confidence', String(roboflowConfidence));
  url.searchParams.set('overlap', String(roboflowOverlap));
  url.searchParams.set('format', 'json');
  return url.toString();
};

const numberValue = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
};

const predictionFromUnknown = (value: unknown): RoboflowPrediction | null => {
  if (!isRecord(value)) return null;
  const x = numberValue(value.x);
  const y = numberValue(value.y);
  const width = numberValue(value.width);
  const height = numberValue(value.height);
  const confidence = numberValue(value.confidence);
  const className = value.class;
  if (
    x === null ||
    y === null ||
    width === null ||
    height === null ||
    confidence === null ||
    typeof className !== 'string'
  ) {
    return null;
  }
  return { x, y, width, height, confidence, class: className };
};

const normalizeClassName = (className: string): string => {
  const compact = className
    .toLowerCase()
    .replace(/mahjong/g, '')
    .replace(/riichi/g, '')
    .replace(/tiles?/g, '')
    .replace(/[\s_.-]+/g, '');

  const honorByName: Array<[RegExp, string]> = [
    [/(east|ton|dong)/, '1z'],
    [/(south|nan)/, '2z'],
    [/(west|shaa|sha|xi)/, '3z'],
    [/(north|pei|bei)/, '4z'],
    [/(white|haku|bai)/, '5z'],
    [/(green|hatsu|fa)/, '6z'],
    [/(chun|red.*dragon|hongzhong|zhong)/, '7z']
  ];
  for (const [pattern, tile] of honorByName) {
    if (pattern.test(compact)) return tile;
  }

  let match = compact.match(/^([mps])([0-9])$/);
  if (match?.[1] && match?.[2]) return `${match[2]}${match[1]}`;

  match = compact.match(/^([mps])([0-9])/);
  if (match?.[1] && match?.[2]) {
    const digit =
      match[2] === '5' && /(aka|red)/.test(compact) ? '0' : match[2];
    return `${digit}${match[1]}`;
  }

  match = compact.match(/^z([1-7])$/);
  if (match?.[1]) return `${match[1]}z`;

  match = compact.match(/^z([1-7])/);
  if (match?.[1]) return `${match[1]}z`;

  match = compact.match(/^([0-9])([mpsz])$/);
  if (match?.[1] && match?.[2]) return `${match[1]}${match[2]}`;

  match = compact.match(/^([0-9])([mps])/);
  if (match?.[1] && match?.[2]) {
    const digit =
      match[1] === '5' && /(aka|red)/.test(compact) ? '0' : match[1];
    return `${digit}${match[2]}`;
  }

  const number = compact.match(/[0-9]/)?.[0] ?? '';
  const suit = /^(?:.*)(man|manzu|character|characters|wan|wanzu)/.test(compact)
    ? 'm'
    : /^(?:.*)(pin|pinzu|circle|circles|dot|dots|tong)/.test(compact)
      ? 'p'
      : /^(?:.*)(sou|souzu|bamboo|bam|suo)/.test(compact)
        ? 's'
        : '';

  if (number && suit) {
    const digit = number === '5' && /(aka|red)/.test(compact) ? '0' : number;
    return `${digit}${suit}`;
  }

  return '';
};

const isValidMpszTile = (tile: string): boolean =>
  /^[0-9][mps]$/.test(tile) || /^[1-7]z$/.test(tile);

const iou = (a: RoboflowPrediction, b: RoboflowPrediction): number => {
  const ax1 = a.x - a.width / 2;
  const ay1 = a.y - a.height / 2;
  const ax2 = a.x + a.width / 2;
  const ay2 = a.y + a.height / 2;
  const bx1 = b.x - b.width / 2;
  const by1 = b.y - b.height / 2;
  const bx2 = b.x + b.width / 2;
  const by2 = b.y + b.height / 2;
  const ix1 = Math.max(ax1, bx1);
  const iy1 = Math.max(ay1, by1);
  const ix2 = Math.min(ax2, bx2);
  const iy2 = Math.min(ay2, by2);
  const intersection = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
  const areaA = a.width * a.height;
  const areaB = b.width * b.height;
  const union = areaA + areaB - intersection;
  return union > 0 ? intersection / union : 0;
};

const dedupePredictions = (
  predictions: RoboflowPrediction[]
): RoboflowPrediction[] => {
  const kept: RoboflowPrediction[] = [];
  for (const candidate of [...predictions].sort(
    (a, b) => b.confidence - a.confidence
  )) {
    if (kept.every(existing => iou(candidate, existing) < dedupeIou)) {
      kept.push(candidate);
    }
  }
  return kept;
};

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

const sortDetectedTiles = (tiles: DetectedTile[]): DetectedTile[] => {
  const rowTolerance = Math.max(8, median(tiles.map(t => t.height)) * 0.55);
  return [...tiles].sort((a, b) => {
    if (Math.abs(a.y - b.y) > rowTolerance) return a.y - b.y;
    return a.x - b.x;
  });
};

const tilesToMpsz = (tiles: string[]): string => {
  const groups: Record<'m' | 'p' | 's' | 'z', string> = {
    m: '',
    p: '',
    s: '',
    z: ''
  };
  for (const tile of tiles) {
    const match = tile.match(/^([0-9])([mpsz])$/);
    if (match?.[1] && match?.[2]) {
      groups[match[2] as 'm' | 'p' | 's' | 'z'] += match[1];
    }
  }
  return (['m', 'p', 's', 'z'] as const)
    .map(suit => (groups[suit] ? `${groups[suit]}${suit}` : ''))
    .join('');
};

const callRoboflow = async (base64Image: string): Promise<unknown> => {
  if (!ROBOFLOW_API_KEY) {
    throw new Error('ROBOFLOW_API_KEY is not set on the server');
  }

  const response = await fetch(roboflowEndpoint(), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: base64Image
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message =
      isRecord(data) && typeof data.error === 'string' ? data.error : text;
    throw new Error(message || `Roboflow request failed (${response.status})`);
  }
  return data;
};

const recognitionFromRoboflow = (data: unknown) => {
  const predictions =
    isRecord(data) && Array.isArray(data.predictions) ? data.predictions : [];
  const parsed = predictions
    .map(predictionFromUnknown)
    .filter((p): p is RoboflowPrediction => p !== null);
  const deduped = dedupePredictions(parsed);
  const detected = deduped
    .map(prediction => ({
      ...prediction,
      tile: normalizeClassName(prediction.class)
    }))
    .filter((prediction): prediction is DetectedTile =>
      isValidMpszTile(prediction.tile)
    );

  const orderedTiles = sortDetectedTiles(detected).map(t => t.tile);
  if (orderedTiles.length === 0) {
    throw new Error('Roboflow did not return any mahjong tile predictions');
  }

  return {
    concealed: tilesToMpsz(orderedTiles),
    melds: [],
    winning_tile: orderedTiles[orderedTiles.length - 1] ?? null,
    aka: []
  };
};

const app = express();
app.use(express.json({ limit: '20mb' }));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    mode: 'roboflow-yolo',
    configured: Boolean(ROBOFLOW_API_KEY),
    model: roboflowModel,
    base_url: roboflowBaseUrl,
    confidence: roboflowConfidence,
    overlap: roboflowOverlap,
    dedupe_iou: dedupeIou
  });
});

app.post('/api/recognize', async (req, res) => {
  try {
    const body = (req.body ?? {}) as { image?: unknown };
    const image = typeof body.image === 'string' ? body.image : '';
    const base64Image = dataUrlToBase64(image);
    if (!base64Image) {
      res.status(400).json({ error: 'No image provided.' });
      return;
    }

    const roboflowResult = await callRoboflow(base64Image);
    res.json(recognitionFromRoboflow(roboflowResult));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[recognize] failed:', message);
    res.status(502).json({ error: message });
  }
});

// Serve the built frontend, then fall back to index.html for client-side
// routes. A path-less middleware keeps this working on Express 5.
app.use(express.static(distDir));
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  res.sendFile(path.join(distDir, 'index.html'));
});

app.listen(port, () => {
  console.log(`mahjong-calc server listening on http://0.0.0.0:${port}`);
  console.log(`  serving static files from ${distDir}`);
  console.log('  recognition: Roboflow YOLO');
  console.log(`  Roboflow model: ${roboflowModel}`);
  console.log(`  Roboflow base URL: ${roboflowBaseUrl}`);
  console.log(
    `  confidence: ${roboflowConfidence}, overlap: ${roboflowOverlap}, dedupe_iou: ${dedupeIou}`
  );
  if (!ROBOFLOW_API_KEY) {
    console.warn(
      '  WARNING: ROBOFLOW_API_KEY is not set - /api/recognize will fail.'
    );
  }
});
