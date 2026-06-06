# mahjong-calc

[![CI](https://github.com/livewing/mahjong-calc/workflows/CI/badge.svg)](https://github.com/livewing/mahjong-calc/actions?query=workflow%3ACI)
[![LICENSE](https://img.shields.io/github/license/livewing/mahjong-calc)](./LICENSE)

![Screenshot](https://user-images.githubusercontent.com/7447366/167593547-c88f910a-65f5-48ec-853b-668efe03c900.png)

麻雀の手牌を入力すると、待ち牌・得点や牌効率の計算をすることができる Web アプリケーション (PWA) です。スマートフォンと PC の Web ブラウザ上で動作します。

Riichi-Mahjong score calculator app in the web browser.

## 実行 - Run

[麻雀得点計算機](https://mahjong-calc.livewing.net/)

This app is available in Japanese, English, Simplified Chinese, and Korean. To translate the app to a new language, see [CONTRIBUTING.md](./CONTRIBUTING.md).

<img src="https://user-images.githubusercontent.com/7447366/107044000-11f10500-6807-11eb-99c9-198b481f0f3e.png" width="185" alt="QR Code" />

## 使用方法 - How to use

[使用方法](./doc/how-to-use.md) (Japanese)

## 開発 - Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## ライセンス - License

[The MIT License](./LICENSE)

## クレジット - Credits

麻雀牌の画像は [FluffyStuff/riichi-mahjong-tiles](https://github.com/FluffyStuff/riichi-mahjong-tiles) のものを使用しています ([CC BY](https://github.com/FluffyStuff/riichi-mahjong-tiles/blob/master/LICENSE.md)) 。

---

# 📸 Photo recognition & self-hosting (fork additions)

This fork adds a **"Photo" button** to the tile input. Take or upload a photo of a
winning hand and a vision LLM fills in the concealed tiles, called melds, the
winning tile, and red fives automatically. You then set riichi / winds / dora /
ron-tsumo with the **existing** controls and the original calculator does the
scoring. The original calculator is untouched — recognition only fills tiles.

## How it works

- The frontend is the original app plus one dialog (`src/recognition/`).
- A tiny **Express backend** (`server/index.ts`):
  1. `POST /api/recognize` — receives a (browser-downscaled) photo, calls a vision
     model, and returns the recognized hand as JSON.
  2. Serves the built frontend (`dist/`) with an SPA fallback.
- Frontend and backend are **same-origin** (one port, one container) → no CORS.
- **The API key lives only on the server.** The browser only ever calls `/api`.

## Provider / model (OpenAI-compatible)

The backend uses the OpenAI-compatible Chat Completions API, so any provider that
speaks it works. Configure via environment variables:

| Variable       | Meaning                              | Example                            |
| -------------- | ------------------------------------ | ---------------------------------- |
| `LLM_BASE_URL` | Provider endpoint (blank = OpenAI)   | `https://api.moonshot.ai/v1`       |
| `LLM_API_KEY`  | Provider API key (server-side only)  | `sk-...`                           |
| `LLM_MODEL`    | A vision-capable model id            | `moonshot-v1-32k-vision-preview`   |
| `PORT`         | Port the server listens on           | `5173` (default)                   |

Known-good combos:

| Provider        | `LLM_BASE_URL`                              | `LLM_MODEL`                                  |
| --------------- | ------------------------------------------- | -------------------------------------------- |
| Kimi (Moonshot) | `https://api.moonshot.ai/v1` (`.cn` in CN)  | `moonshot-v1-32k-vision-preview`, `kimi-k2.5`|
| MiniMax         | `https://api.minimax.io/v1`                 | `MiniMax-M3`                                 |
| OpenAI          | `https://api.openai.com/v1` (or blank)      | `gpt-4o`                                     |
| Claude          | `https://api.anthropic.com/v1/`             | `claude-opus-4-8`                            |

## Local development

Prerequisites: Node 22+, Rust + `wasm-pack` (the decomposer is compiled from Rust).

```sh
# one-time: build the wasm package, then install deps
npm run build:wasm
npm install

# terminal 1 — backend on http://localhost:8787
LLM_BASE_URL=... LLM_API_KEY=... LLM_MODEL=... npm run server:dev

# terminal 2 — frontend on http://localhost:5173 (proxies /api to :8787)
npm run dev
```

Open http://localhost:5173. Without the `LLM_*` vars the calculator still works
fully; only photo recognition is disabled.

## Production — Docker Compose

One container builds the frontend and serves it + `/api` on a single port.

```sh
cp .env.example .env      # then fill in LLM_BASE_URL / LLM_API_KEY / LLM_MODEL
docker compose up -d --build
```

The app is then at `http://<host>:5173` (set `APP_PORT` in `.env` for a different
host port). The base images are multi-arch, so the same build works on Apple
Silicon and on a Raspberry Pi (arm64).

## Deploy on a Raspberry Pi with Portainer

1. Push this project to a Git repo (GitHub/Gitea) the Pi can reach — **do not**
   commit your `.env` (it's git-ignored and docker-ignored by default).
2. In Portainer: **Stacks → Add stack**.
3. Name it `mahjong`, choose **Repository**, and point it at your repo URL, the
   branch, and the compose path `docker-compose.yml`.
4. Under **Environment variables**, add:
   - `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` — your provider settings
   - optionally `APP_PORT` — the host port (default `5173`)
5. **Deploy the stack.** Portainer clones the repo and runs the multi-stage build
   on the Pi. The first build takes a few minutes (it compiles the Rust→wasm
   package). When it's up, the app is at `http://<pi-ip>:5173`.
6. Point Cloudflare / your DNS at the Pi. The service only needs port 5173 — no
   reverse-proxy or TLS config is required on this side.

Update later: push to the repo, then **Pull and redeploy** the stack in Portainer.

You can sanity-check the backend at `http://<host>:<port>/api/health` — it reports
whether a key and model are configured.

## What recognition fills (and what it doesn't)

- **Fills:** concealed tiles, called melds (chi / pon / kan), the winning tile, red fives.
- **You set manually (unchanged):** riichi / ippatsu / etc., round & seat wind,
  dora indicators, ron vs tsumo, and the rule set.
- Called melds carry no "called-from" direction (it doesn't affect Japanese
  scoring). A kan defaults to **open**; toggle the existing closed-kan control if needed.
- If recognition is wrong, fix the tiles with the normal controls or take another
  photo. If the backend isn't configured or the call fails, you get a clear error
  and can still input the hand by hand.
