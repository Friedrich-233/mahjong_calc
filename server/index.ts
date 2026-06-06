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

const {
  PORT,
  DIST_DIR,
  LLM_API_KEY,
  LLM_BASE_URL,
  LLM_MODEL,
  LLM_PROVIDER,
  LLM_THINKING,
  LLM_MAX_TOKENS
} = process.env;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(PORT) || 5173;
const distDir = DIST_DIR || path.resolve(__dirname, '..', 'dist');
const llmThinking = (LLM_THINKING || 'adaptive').toLowerCase();
const maxOutputTokens = Number(LLM_MAX_TOKENS) || 3000;

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
- Think carefully before the final answer: segment visible tiles, classify each tile, check total count, identify separated/rotated called melds, then reconcile the result to the JSON contract.
- Do not reveal reasoning in the final answer. The final answer must be JSON only.
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

type ChatCompletionParams = Parameters<
  OpenAI['chat']['completions']['create']
>[0] & {
  max_tokens?: number;
  max_completion_tokens?: number;
  thinking?: { type: 'disabled' | 'enabled' | 'adaptive' };
  reasoning_split?: boolean;
};

type Provider = 'minimax' | 'kimi' | 'openai' | 'claude' | 'compatible';

const inferProvider = (): Provider => {
  const explicit = (LLM_PROVIDER || 'auto').toLowerCase();
  if (
    explicit === 'minimax' ||
    explicit === 'kimi' ||
    explicit === 'openai' ||
    explicit === 'claude' ||
    explicit === 'anthropic' ||
    explicit === 'compatible'
  ) {
    return explicit === 'anthropic' ? 'claude' : explicit;
  }

  const baseUrl = (LLM_BASE_URL || '').toLowerCase();
  const model = (LLM_MODEL || '').toLowerCase();
  if (baseUrl.includes('minimax') || model.startsWith('minimax')) {
    return 'minimax';
  }
  if (
    baseUrl.includes('moonshot') ||
    baseUrl.includes('kimi') ||
    model.startsWith('kimi') ||
    model.startsWith('moonshot')
  ) {
    return 'kimi';
  }
  if (baseUrl.includes('anthropic') || model.startsWith('claude')) {
    return 'claude';
  }
  if (!baseUrl || baseUrl.includes('openai')) return 'openai';
  return 'compatible';
};

const provider = inferProvider();
const isMiniMaxM3 =
  provider === 'minimax' && (LLM_MODEL ?? '').toLowerCase() === 'minimax-m3';

const tokenParamForProvider = (
  p: Provider
): Pick<ChatCompletionParams, 'max_completion_tokens' | 'max_tokens'> =>
  p === 'claude'
    ? { max_tokens: maxOutputTokens }
    : { max_completion_tokens: maxOutputTokens };

const temperatureParamForProvider = (
  p: Provider
): Pick<ChatCompletionParams, 'temperature'> =>
  p === 'kimi' ? {} : { temperature: 0 };

const swapTokenParam = (params: ChatCompletionParams): ChatCompletionParams => {
  const { max_completion_tokens, max_tokens, ...rest } = params;
  return typeof max_completion_tokens === 'number'
    ? { ...rest, max_tokens: max_completion_tokens }
    : { ...rest, max_completion_tokens: max_tokens ?? maxOutputTokens };
};

const findJsonObject = (text: string): string | null => {
  const quotedAnchor = text.indexOf('"concealed"');
  const looseAnchor = text.search(/\bconcealed\b/);
  const anchor = quotedAnchor >= 0 ? quotedAnchor : looseAnchor;
  if (anchor < 0) return null;
  const start = text.lastIndexOf('{', anchor);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
};

const repairJsonLikeObject = (text: string): string =>
  text
    .trim()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\bNone\b|\bnil\b|\bundefined\b/gi, 'null')
    .replace(/,\s*([}\]])/g, '$1')
    .replace(
      /([{,]\s*)(concealed|melds|type|tiles|from|winning_tile|aka)\s*:/g,
      '$1"$2":'
    )
    .replace(/:\s*'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_, value: string) => {
      return `: "${value.replace(/"/g, '\\"')}"`;
    });

const parseJsonObject = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return JSON.parse(repairJsonLikeObject(text));
  }
};

// Models sometimes wrap JSON in fences, add stray prose, or (MiniMax M3 by
// default) prepend <think>...</think>. Prefer the object containing our contract
// key instead of blindly parsing the first brace in the response.
const extractJson = (raw: string): unknown => {
  let text = raw.trim();
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) text = fence[1].trim();
  const objectText = findJsonObject(text);
  if (objectText === null) {
    throw new Error('No JSON object found in model output');
  }
  return parseJsonObject(objectText);
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

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

const createChatCompletion = async (params: ChatCompletionParams) => {
  try {
    return await getClient().chat.completions.create(params);
  } catch (err) {
    const message = errorMessage(err).toLowerCase();
    if (
      message.includes('max_completion_tokens') ||
      message.includes('max_tokens')
    ) {
      console.warn('[recognize] retrying with alternate token parameter');
      return await getClient().chat.completions.create(swapTokenParam(params));
    }
    if (message.includes('temperature')) {
      const { temperature, ...withoutTemperature } = params;
      console.warn('[recognize] retrying without temperature parameter');
      return await getClient().chat.completions.create(withoutTemperature);
    }
    if (
      'thinking' in params ||
      'reasoning_split' in params ||
      message.includes('thinking') ||
      message.includes('reasoning_split')
    ) {
      const { thinking, reasoning_split, ...withoutThinking } = params;
      console.warn('[recognize] retrying without provider thinking extensions');
      return await getClient().chat.completions.create(withoutThinking);
    }
    throw err;
  }
};

const app = express();
app.use(express.json({ limit: '20mb' }));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    mode: 'llm',
    provider,
    configured: Boolean(LLM_API_KEY),
    thinking: isMiniMaxM3 ? llmThinking : 'prompt-only',
    max_tokens: maxOutputTokens,
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

    const completionParams: ChatCompletionParams = {
      model: LLM_MODEL,
      ...tokenParamForProvider(provider),
      ...temperatureParamForProvider(provider),
      ...(isMiniMaxM3
        ? {
            thinking: {
              type: llmThinking === 'disabled' ? 'disabled' : 'adaptive'
            } as const,
            reasoning_split: true
          }
        : {}),
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Carefully reason about the visible tiles and called melds, but return only the final JSON object. Do not include markdown, prose, or reasoning in the final content.'
            },
            { type: 'image_url', image_url: { url: dataUrl } }
          ]
        }
      ]
    };

    const completion = await createChatCompletion(completionParams);

    const raw = contentToText(completion.choices?.[0]?.message?.content);
    if (!raw.trim()) {
      res.status(502).json({ error: 'The model returned an empty response.' });
      return;
    }

    try {
      const parsed = extractJson(raw);
      res.json(parsed);
    } catch {
      console.warn('[recognize] non-json model output:', raw.slice(0, 500));
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
  console.log(
    `  LLM: ${LLM_MODEL ?? '(LLM_MODEL not set)'} @ ${LLM_BASE_URL ?? 'OpenAI default'}`
  );
  console.log(`  provider: ${provider}`);
  console.log(`  max output tokens: ${maxOutputTokens}`);
  if (isMiniMaxM3) {
    console.log(`  MiniMax thinking: ${llmThinking}`);
  }
  if (!LLM_API_KEY) {
    console.warn(
      '  WARNING: LLM_API_KEY is not set — /api/recognize will fail.'
    );
  }
});
