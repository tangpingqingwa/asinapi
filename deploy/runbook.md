# AsinAPI — one-VPS runbook

Single Docker host. SQLite on a volume. The adapter stays on fixtures until you set `ASINAPI_ADAPTER=live`.

## Env

Copy [`.env.example`](../.env.example) to `/etc/asinapi.env` (mode `600`). Set:

| Variable | Production |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | listen port (default `3000`) |
| `ASINAPI_DATABASE` | required; must sit on the volume, e.g. `/app/data/asinapi.sqlite` |
| `ASINAPI_BOOTSTRAP_KEY` | optional first `ak_live_...` when the keys table is empty |
| `ASINAPI_ADAPTER` | leave unset. `live` selects the Amazon adapter |
| `ASINAPI_FIXTURE_ONLY` | leave unset on the VPS. `1` wins over live (CI) |

Do not bake secrets into the image. Do not commit `.env`. A bind-mount over `/app/data` must be writable by uid `1000` (`node`).

## Build and run

```bash
docker build -t asinapi:local .
docker run -d --name asinapi --restart unless-stopped --init \
  --env-file /etc/asinapi.env \
  -p 127.0.0.1:3000:3000 \
  -v asinapi-data:/app/data \
  asinapi:local
```

The process listens on `0.0.0.0:$PORT` as the non-root `node` user (uid 1000). Keep the published port on loopback and terminate TLS on Caddy or nginx.

## Health

`GET /healthz` → `200 {"ok":true}`. No auth.

```bash
curl -fsS "http://127.0.0.1:${PORT:-3000}/healthz"
```

After bootstrap:

```bash
curl -fsS -H "Authorization: Bearer $ASINAPI_BOOTSTRAP_KEY" \
  "http://127.0.0.1:${PORT:-3000}/v1/me"
```

## Enable live Amazon

1. Confirm `/healthz` is green with live off (fixture adapter).
2. Set `ASINAPI_ADAPTER=live`. `ASINAPI_FIXTURE_ONLY=1` keeps fixtures.
3. Recreate the container. Live fetches public US `.com` listing HTML only.
4. CAPTCHA / 503 map to `upstream_blocked` (0 credits). Titles and reviews are never invented. Offers stay `501`.
5. Leave live flags unset in CI. `scripts/test.sh` sets `ASINAPI_FIXTURE_ONLY=1` and unsets `ASINAPI_ADAPTER`.

Roll back: unset `ASINAPI_ADAPTER` (or set `ASINAPI_FIXTURE_ONLY=1`) and recreate. Do not run live Amazon from CI.
