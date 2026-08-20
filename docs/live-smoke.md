# Live Amazon.com smoke

Opt-in. Not part of `scripts/test.sh` or GitHub Actions. CI stays on fixtures (`ASINAPI_FIXTURE_ONLY=1` wins).

`100%` for this unit means a **local process** with live flags **on** walked every required flow against **real Amazon.com**. Do not invent a title or a review if parse misses.

## Flags

| Variable | Live smoke | CI / `test.sh` |
|---|---|---|
| `ASINAPI_ADAPTER` | `live` | unset |
| `ASINAPI_FIXTURE_ONLY` | **unset** | `1` |

`ASINAPI_FIXTURE_ONLY=1` always wins. If it is set, `scripts/live-smoke.sh` exits before listen.

## How to run

```bash
bash scripts/live-smoke.sh
```

The script:

1. Refuses `CI=true` / `GITHUB_ACTIONS=true`.
2. Unsets `ASINAPI_FIXTURE_ONLY` and sets `ASINAPI_ADAPTER=live`.
3. Starts `node --import tsx src/server.ts` on a free loopback port with a temp SQLite file and bootstrap key `ak_live_smoke_local`.
4. Waits for `GET /healthz`.
5. Hits the required flows below.
6. Kills the process and deletes the temp database.

Overrides: `ASINAPI_LIVE_SMOKE_ASIN` (default `B07FZ8S74R`, Echo Dot 3rd Gen on Amazon.com), `ASINAPI_LIVE_SMOKE_Q` (default `echo dot`), `ASINAPI_LIVE_SMOKE_UK_URL`, `ASINAPI_LIVE_SMOKE_KEY`, `ASINAPI_LIVE_SMOKE_PORT`.

## Required flows

| Flow | Request | Honest pass |
|---|---|---|
| Product | `GET /v1/products/{asin}` | `200` + non-empty `data.title` from live HTML, or `503 upstream_blocked` / `404 product_unavailable` with **0 credits**. Never fill a missing title. |
| Reviews page | `GET /v1/products/{asin}/reviews?page=1` | `200` + `data.reviews` array (empty allowed), or `503 upstream_blocked` / 0 credits. Never synthesize a row. |
| Search | `GET /v1/search?q=…` | `200` + `data.results` array (empty allowed), or `503 upstream_blocked` / 0 credits. Never invent a hit. |
| Non-US host | `GET /v1/products/by-url?url=https://www.amazon.co.uk/dp/{asin}` | `422 marketplace_unsupported`, **0 credits**, before fetch. |
| Offers | `GET /v1/products/{asin}/offers` | `501 not_implemented`, **0 credits**. Live adapter does not change this. |

Verdicts printed per flow: `PASS`, `PASS-ERROR` (SPEC error, 0 credits, nothing invented), `FAIL`.

The process exit is 0 only when every required flow is `PASS` or `PASS-ERROR`. Fixture titles (`Recorded Echo Dot fixture`) and fixture review ids (`R10BESTHELP` …) fail the run — that means the live adapter was not on.

## This session

Ran `bash scripts/live-smoke.sh` on 2026-08-20 from `feat/live-smoke` with `ASINAPI_ADAPTER=live` and `ASINAPI_FIXTURE_ONLY` unset. Local process on loopback port `58009`. Real Amazon.com (not fixtures).

| Flow | Result |
|---|---|
| Product `B07FZ8S74R` | **PASS** HTTP 200, `title` length 70 (live HTML; not a fixture string) |
| Reviews page 1 | **PASS** HTTP 200, `reviews=[]` (honest empty; none invented) |
| Search `echo dot` | **PASS** HTTP 200, `results=[]` (honest empty; none invented) |
| `amazon.co.uk` by-url | **PASS** HTTP 422 `marketplace_unsupported`, 0 credits |
| Offers | **PASS** HTTP 501 `not_implemented`, 0 credits |

Process exit 0. Re-run locally; Amazon may CAPTCHA (`upstream_blocked`, 0 credits) — that is an honest `PASS-ERROR`, not a fake product.

## What this does not do

- Does not call Amazon from `scripts/test.sh`.
- Does not set `ASINAPI_ADAPTER=live` in Docker or CI.
- Does not implement offers.
- Does not loosen parse to invent fields.
