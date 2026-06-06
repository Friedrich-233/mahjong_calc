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

# 📸 Roboflow YOLO recognition & self-hosting (fork branch)

This branch adds a **"Photo" button** to the tile input and uses Roboflow Hosted
YOLO inference to detect tile classes. It is intentionally **Roboflow-only**:
there is no LLM call, no OpenAI-compatible provider layer, and no API key in the
browser.

Current limitation: Roboflow object detection returns boxes and classes only.
This branch sorts detected tiles visually, fills all detections as concealed
tiles, and treats the last detected tile as the winning tile. It does **not**
infer called melds, rotated tile direction, or red fives. Use it to compare pure
YOLO tile classification quality.

## How it works

- The frontend is the original app plus one dialog (`src/recognition/`).
- A tiny **Express backend** (`server/index.ts`):
  1. `POST /api/recognize` receives a browser-downscaled photo.
  2. The backend sends base64 image data to Roboflow.
  3. Roboflow class names like `m1`, `p5`, `z7` are converted to mpsz.
  4. The backend returns the same JSON contract the frontend already applies.
- Frontend and backend are **same-origin** (one port, one container) -> no CORS.
- The Roboflow API key lives only on the server. The browser only calls `/api`.

Default model:

`riichi-mahjong-tiles-y8hce/1`

Model page:

https://universe.roboflow.com/stanislavs-workspace-iwibi/riichi-mahjong-tiles-y8hce/model/1

Roboflow Hosted API docs:

https://docs.roboflow.com/deploy/serverless/object-detection

## Roboflow configuration

| Variable | Meaning | Default |
| --- | --- | --- |
| `ROBOFLOW_API_KEY` | Roboflow API key, server-side only | empty |
| `ROBOFLOW_BASE_URL` | Hosted inference endpoint | `https://serverless.roboflow.com` |
| `ROBOFLOW_MODEL` | Roboflow model id | `riichi-mahjong-tiles-y8hce/1` |
| `ROBOFLOW_CONFIDENCE` | Detection confidence threshold, 0-100 | `30` |
| `ROBOFLOW_OVERLAP` | Roboflow overlap/NMS setting, 0-100 | `30` |
| `ROBOFLOW_DEDUP_IOU` | Extra server-side duplicate-box filter, 0-1 | `0.55` |
| `PORT` | Port the server listens on inside the container | `5173` |

If predictions miss tiles, lower `ROBOFLOW_CONFIDENCE`. If duplicate boxes
produce extra tiles, lower `ROBOFLOW_DEDUP_IOU` or raise `ROBOFLOW_CONFIDENCE`.

## Local development

Prerequisites: Node 22+, Rust + `wasm-pack` (the decomposer is compiled from Rust).

```sh
# one-time: build the wasm package, then install deps
npm run build:wasm
npm install

# terminal 1 - backend on http://localhost:8787
ROBOFLOW_API_KEY=... npm run server:dev

# terminal 2 - frontend on http://localhost:5173 (proxies /api to :8787)
npm run dev
```

Open http://localhost:5173. Without `ROBOFLOW_API_KEY`, the calculator still
works fully; only photo recognition fails with a clear message.

## Production - Docker Compose

One container builds the frontend and serves it + `/api` on a single port.

```sh
cp .env.example .env      # fill in ROBOFLOW_API_KEY
docker compose up -d --build
```

The app is then at `http://<host>:5173` (set `APP_PORT` in `.env` for a different
host port). The base images are multi-arch, so the same build works on Apple
Silicon and on a Raspberry Pi (arm64).

## Deploy on a Raspberry Pi with Portainer

1. Push this branch to a Git repo the Pi can reach. Do not commit your `.env`.
2. In Portainer: **Stacks -> Add stack**.
3. Name it `mahjong`, choose **Repository**, and point it at your repo URL, this
   branch, and the compose path `docker-compose.yml`.
4. Under **Environment variables**, add:
   - `ROBOFLOW_API_KEY` - required
   - optionally `ROBOFLOW_MODEL`, `ROBOFLOW_CONFIDENCE`, `ROBOFLOW_OVERLAP`,
     `ROBOFLOW_DEDUP_IOU`
   - optionally `APP_PORT` - host port, default `5173`
5. **Deploy the stack.** Portainer clones the repo and runs the multi-stage build
   on the Pi. The first build takes a few minutes because it compiles the
   Rust->wasm package. When it is up, the app is at `http://<pi-ip>:5173`.

Update later: push to the repo, then **Pull and redeploy** the stack in Portainer.

You can sanity-check the backend at `http://<host>:<port>/api/health`. It reports
whether a Roboflow key is configured and which model/thresholds are active.

## What recognition fills

- **Fills in this branch:** YOLO-detected tile classes, sorted into the hand; the
  last detected tile is marked as the winning tile.
- **Not filled in this branch:** melds, red fives, true winning-tile separation,
  riichi / ippatsu / winds / dora / ron-tsumo / rule options.
- If recognition is wrong, fix the tiles with the normal controls or take another
  photo. If the backend is not configured or the call fails, you get a clear
  error and can still input the hand by hand.
