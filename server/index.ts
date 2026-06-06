import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import OpenAI from 'openai';

// ---------------------------------------------------------------------------
// Minimal backend for mahjong-calc:
//   * POST /api/recognize  – send a photo to a vision LLM, get back the hand
//   * GET  /api/health     – quick "is it configured" probe
//   * everything else      – serve the built frontend (dist/) with SPA fallback
//
// The LLM call uses the OpenAI-compatible Chat Completions API, so the same
// code works with any provider that speaks it (Kimi/Moonshot, MiniMax, OpenAI,
// OpenRouter, or Claude via Anthropic's OpenAI-compat endpoint). Pick the
// provider purely through environment variables:
//   LLM_BASE_URL  – e.g. https://api.moonshot.ai/v1   (omit for OpenAI default)
//   LLM_API_KEY   – the provider's API key            (server-side only!)
//   LLM_MODEL     – a vision-capable model id
// The API key never reaches the browser: the frontend only ever calls /api.
// ---------------------------------------------------------------------------

const { PORT, DIST_DIR, LLM_API_KEY, LLM_BASE_URL, LLM_MODEL } = process.env;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(PORT) || 5173;
const distDir = DIST_DIR || path.resolve(__dirname, '..', 'dist');

const SYSTEM_PROMPT = `You are an expert Japanese riichi mahjong tile recognizer. You are given ONE photo of a player's winning hand; called melds may be laid to the side and are often rotated. Identify every tile.

Output ONLY a JSON object (no prose, no markdown fences) of exactly this shape:
{
  "concealed": "<tiles in mpsz>",
  "melds": [ { "type": "chi"|"pon"|"kan", "tiles": "<mpsz>", "from": "left"|"across"|"right" } ],
  "winning_tile": "<one tile in mpsz, or null>",
  "aka": ["<red fives like 0m/0p/0s>"]
}

mpsz notation: m = man (characters), p = pin (circles/dots), s = sou (bamboo), z = honors where 1z..7z = East, South, West, North, White (haku), Green (hatsu), Red (chun). Write digits then suit, e.g. 123m, 5566p, 789s, 11z. Red fives are written as 0 (0m, 0p, 0s).

Rules:
- Count carefully. A complete winning hand is 14 tiles total across concealed + meld tiles + winning tile.
- Tiles that are called / rotated / set apart go in "melds"; the rest go in "concealed".
- Detect red fives by their red center and use 0.
- Do NOT infer round wind, seat wind, riichi, dora, or ron-vs-tsumo. Those are out of scope.
- If a tile is ambiguous, pick the single most likely tile and still return valid JSON.`;

// Reuse one client across requests; configuration comes from the environment.
let openaiClient: OpenAI | null = null;
const getClient = (): OpenAI => {
  if (!LLM_API_KEY) throw new Error('LLM_API_KEY is not set on the server');
  if (openaiClient === null) {
    openaiClient = new OpenAI(
      LLM_BASE_URL
        ? { apiKey: LLM_API_KEY, baseURL: LLM_BASE_URL }
        : { apiKey: LLM_API_KEY }
    );
  }
  return openaiClient;
};

// Models sometimes wrap JSON in ```json ... ``` fences or add stray prose.
// Strip fences, then take the outermost {...} and parse it.
const extractJson = (raw: string): unknown => {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('No JSON object found in model output');
  }
  return JSON.parse(text.slice(start, end + 1));
};

// Some providers return message.content as an array of content parts.
const contentToText = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(part =>
        typeof part === 'string'
          ? part
          : part && typeof part === 'object' && 'text' in part
            ? String((part as { text: unknown }).text)
            : ''
      )
      .join('');
  }
  return '';
};

const app = express();
app.use(express.json({ limit: '20mb' }));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    configured: Boolean(LLM_API_KEY),
    model: LLM_MODEL ?? null,
    base_url: LLM_BASE_URL ?? 'https://api.openai.com/v1 (default)'
  });
});

app.post('/api/recognize', async (req, res) => {
  try {
    const body = (req.body ?? {}) as { image?: unknown; media_type?: unknown };
    const image = typeof body.image === 'string' ? body.image : '';
    const mediaType =
      typeof body.media_type === 'string' ? body.media_type : 'image/jpeg';
    if (!image) {
      res.status(400).json({ error: 'No image provided.' });
      return;
    }

    if (!LLM_MODEL) {
      res
        .status(500)
        .json({ error: 'LLM_MODEL is not configured on the server.' });
      return;
    }

    // Accept either a bare base64 string or a full data URL.
    const dataUrl = image.startsWith('data:')
      ? image
      : `data:${mediaType};base64,${image}`;

    const completion = await getClient().chat.completions.create({
      model: LLM_MODEL,
      max_tokens: 1500,
      temperature: 0,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Recognize the hand in this photo. Output only the JSON object.'
            },
            { type: 'image_url', image_url: { url: dataUrl } }
          ]
        }
      ]
    });

    const raw = contentToText(completion.choices?.[0]?.message?.content);
    if (!raw.trim()) {
      res.status(502).json({ error: 'The model returned an empty response.' });
      return;
    }

    try {
      const parsed = extractJson(raw);
      res.json(parsed);
    } catch {
      res
        .status(502)
        .json({ error: 'The model did not return valid JSON.', raw });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[recognize] failed:', message);
    res.status(502).json({ error: message });
  }
});

// Serve the built frontend, then fall back to index.html for client-side
// routes. A path-less middleware (rather than app.get('*')) keeps this working
// on Express 5, whose router no longer accepts a bare "*" path pattern.
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
  console.log(`  LLM: ${LLM_MODEL ?? '(LLM_MODEL not set)'} @ ${LLM_BASE_URL ?? 'OpenAI default'}`);
  if (!LLM_API_KEY) {
    console.warn('  WARNING: LLM_API_KEY is not set — /api/recognize will fail.');
  }
});
