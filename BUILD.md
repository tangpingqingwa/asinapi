# AsinAPI — Detailed Specification and Build Plan

**Contract:** [SPEC.md](./SPEC.md)  
**Git:** [CONTRIBUTING.md](./CONTRIBUTING.md)

US `.com` only. Keys `ak_live_`. Proxy COGS is real — search is optional until product+reviews are boring.

---

## 1. Stack

Node 22, Fastify, SQLite cache, fixture HTML snapshots in `tests/fixtures/html/`.  
Live adapter isolated; unit tests never hit Amazon.

---

## 2. Product record (implementation)

Implement the SPEC TypeScript shape **exactly**. Do not add unofficial fields in v1. `?fields=` is PR 5.

ASIN: `/^[A-Z0-9]{10}$/`. Lowercase input is uppercased. Anything else `invalid_asin`.

URL parser accepts `/dp/`, `/gp/product/`, query `asin=`. `amzn.to` → HTTP HEAD follow **in live adapter only**; fixtures include already-resolved maps.

Non-US host (`amazon.co.uk`, `amazon.de`, …) → `marketplace_unsupported` before fetch.

---

## 3. Review page

1-based `page`. Empty page is 200 `{ reviews: [], hasMore: false }` not 404.  
Never synthesize a review to fill a hole.

---

## 4. Offers

`GET /v1/products/{asin}/offers` returns **501 `not_implemented`**, 0 credits, until a dedicated PR after 7 green days of product+reviews. Homepage must not mention offers until then.

---

## 5. Tests

50 ASINs listed in `tests/fixtures/asins.json` with expected `{ titlePresent, unavailable, hasReviews }`.  
CI runs parser + 5 representative HTML fixtures (not all 50 live).  
A layout change that drops `title` fails the fixture test.

---

## 6. PR plan

### PR 1: Skeleton + keys + envelope
- **Dependencies:** None

### PR 2: Product by ASIN/url + OpenAPI freeze
- **Description:** parse ASIN/url, fixture products, `/v1/products/{asin}` and `by-url`.
- **Files:** core/product.ts, adapters/amazon/fixture.ts, routes, openapi, tests/product.test.ts, fixtures
- **Dependencies:** PR 1
- **Acceptance:** SPEC 1–3, 5–6

### PR 3: Reviews page 1
- **Files:** core/reviews.ts, fixtures, tests
- **Dependencies:** PR 2
- **Acceptance:** SPEC 4; never fake reviews

### PR 4: MCP get_product + list_reviews
- **Dependencies:** PR 3

### PR 5: Search + fields projection
- **Dependencies:** PR 2
- **Acceptance:** page cap 5; charge 1 / result

### PR 6: offers 501 documented
- **Dependencies:** PR 1
- **Acceptance:** 501 0 credits

Live adapter + proxy metrics dashboard = after PR 4, separate chore PRs.

Live adapter is env-gated (`ASINAPI_ADAPTER=live`). Default remains the fixture adapter. `ASINAPI_FIXTURE_ONLY=1` always wins so CI stays offline. `amzn.to` HEAD follow lives only in the live adapter.
