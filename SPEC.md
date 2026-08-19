# AsinAPI — Product Development Spec

**Version:** 1.0  
**Status:** Ready to build  
**Repo:** https://github.com/tangpingqingwa/asinapi  
**Marketplace v1:** Amazon.com (US) only

Public product + review JSON for builders who cannot get Product Advertising API (need an Associates account that already sells).

---

## 1. Product statement

Same-day key. One REST call returns a typed US Amazon product record. Reviews paginated. MCP for agents.

One-line pitch: **ASIN in. Price, bullets, rating, review page out. No Associates waitlist.**

Win vs Keepa/Rainforest: signup today, MCP, predictable errors — not “cheaper on every SKU.”

---

## 2. Goals and non-goals

### Goals

- `GET /v1/products/{asin}` useful (non-empty title + price or explicit `unavailable`) for p95 of a 50-ASIN fixture set.
- Reviews: star, title, body, date, verified flag if shown.
- Failed CAPTCHA / 503 → `upstream_blocked`, **0 credits**.
- Proxy + host < 25% of revenue or we raise prices / cut search.
- US `.com` only until fixtures are boring.

### Non-goals

- Cart, checkout, Buy with Prime.
- Invented BSR history graphs.
- 20 marketplaces.
- Review generation or “we post this review.”
- Hosting Amazon image bytes.

---

## 3. Auth and envelope

Bearer `ak_live_...`. Same envelope as ClipAPI.

Extra codes:

| code | HTTP | meaning |
|---|---|---|
| `invalid_asin` | 400 | not a 10-char ASIN |
| `product_unavailable` | 404 | gone / suppressed |
| `marketplace_unsupported` | 422 | non-US URL in v1 |
| `not_implemented` | 501 | offers (and similar) until staging is green; 0 credits |
| `upstream_blocked` | 503 | captcha / bot wall |

---

## 4. Endpoints

### 4.1 `GET /v1/products/by-url`

**Credits:** 1. Accepts `amazon.com/dp/`, `/gp/product/`, short `amzn.to` (resolve first). Non-US host → `marketplace_unsupported`.

### 4.2 `GET /v1/products/{asin}`

**Credits:** 1.

`data` (honest subset; do not pad to fake “300+” if we cannot type them):

```ts
{
  asin: string
  marketplace: "US"
  title: string
  brand: string | null
  url: string
  images: string[]          // remote URLs, max 10
  price: {
    amount: number | null   // major units
    currency: "USD"
    display: string | null
    unavailable: boolean
  }
  rating: { average: number | null, count: number | null }
  bullets: string[]
  description: string | null
  categoryPath: string[]
  bsr: Array<{ rank: number, category: string }> | null  // only if visible
  attributes: Record<string, string>  // "Color" → "Blue" etc, best-effort
  fetchedAt: string
}
```

OpenAPI freezes this list. Adding fields is backwards compatible. Removing = `/v2`.

`?fields=` dotted projection optional in M3.

### 4.3 `GET /v1/products/{asin}/reviews`

**Credits:** 1 / page. Query: `page` (1-based), `sort` (`helpful` \| `recent` if available).

```ts
{
  page: number
  hasMore: boolean
  reviews: Array<{
    id: string | null
    title: string | null
    body: string
    stars: number
    createdAt: string | null
    verified: boolean | null
    author: string | null
    country: string | null
  }>
}
```

Never invent a review.

### 4.4 `GET /v1/search`

**Credits:** 1 / result returned (min 1 if the page is a valid search with hits). Query: `q`, `page`.

Each result: asin, title, price, rating, url, image.

Cap `page` at 5 in v1.

### 4.5 `GET /v1/products/{asin}/offers`

**Credits:** 2. Buy box + other sellers **only if** the adapter is stable for 7 days in staging. Until then the route returns `501` with `error.code = not_implemented` and 0 credits. Do not advertise on the homepage until 200s.

### 4.6 Control plane

`/v1/me`, `/v1/usage`, `/healthz`.

---

## 5. Billing

| Plan | Price | Credits | Top-up |
|---|---|---|---|
| Free | $0 | 100 once | — |
| Monthly | $19 | 2,000 | $10 / 1k |
| Annual | $190 | 2,000 / mo | $8 / 1k |

Higher than ClipAPI because proxy COGS is real.

Weekly dashboard: proxy $, host $, revenue. If proxy+host > 25% revenue for 2 weeks: raise top-up or disable search.

---

## 6. Caching

| Resource | TTL |
|---|---|
| Product (title, bullets, images) | 24h |
| Price / unavailable | 6h |
| Reviews `(asin, page, sort)` | 24h |
| Search | 6h |

Tombstone `product_unavailable` for 12h.

Images: URLs only. `referrerpolicy=no-referrer` if we ever render them.

---

## 7. Fixtures and CI

`/tests/fixtures/asins.json` — 50 US ASINs: commodity, book, unavailable, variation parent, adult-adjacent (must 200 or explicit error, never 500).

HTML snapshot tests for the adapter. Layout change fails CI. No silent field drop.

---

## 8. MCP

`get_product`, `list_reviews`, `search_amazon`.

Skill: US only; not for checkout; prices can be 6h stale; do not claim Keepa-like history.

SEO: `Amazon Product Advertising API requirements in 2026`.

---

## 9. Acceptance

| # | Case | Expected |
|---|---|---|
| 1 | Well-known ASIN (e.g. a bestseller) | title + image + rating or price |
| 2 | by-url `amazon.com/dp/{asin}` | same as 1 |
| 3 | `amzn.to` short link | resolve then 1 |
| 4 | Review page 1 | ≥1 review or empty list, never fake |
| 5 | `.co.uk` URL | 422 marketplace_unsupported, 0 credit |
| 6 | Garbage ASIN | 400 or 404, 0 credit |
| 7 | Forced adapter 503 | upstream_blocked, 0 credit |
| 8 | OpenAPI validates fixture payloads | |

---

## 10. Milestones

**M1:** product by ASIN/url + frozen OpenAPI + 50 fixtures.  
**M2:** reviews; keys; $19 Stripe.  
**M3:** search + fields projection.  
**M4:** MCP + SEO post.  
**M5:** offers if staging green.

Launch = M2.

---

## 11. Legal

Read-only public listing data. Independent, not Amazon. Customer ToS: no account takeover, no review fraud, no using us to undercut Buy Box with bots that place orders. If PA-API becomes easy, we become a nicer facade, we do not “win at scraping.”

## 12. Git collaboration (normative)

Development is GitHub trunk-based. **`main` is always cloneable, buildable, and testable.**

| Rule | Requirement |
|---|---|
| Integration branch | `main` only. No long-lived `develop`. |
| How code lands | Pull request into `main`. No direct push. |
| Required check | GitHub Actions workflow `ci` (job id `ci`) must be green. |
| Local / CI test | `bash scripts/test.sh` — offline, no production secrets. |
| Branch names | `feat/` `fix/` `docs/` `chore/` `test/` + short slug. |
| Merge | Squash. Delete the head branch. |
| Broken `main` | Treat as an incident. Fix on `fix/…` via PR. |

Full process: [CONTRIBUTING.md](./CONTRIBUTING.md).

Implementation plan (stack, modules, PR DAG): [BUILD.md](./BUILD.md).

Until there is an application binary, `scripts/test.sh` still has to pass: contract files exist, SPEC/CONTRIBUTING agree, no tracked secrets. Adding a server or CLI means **extending** that script with unit/contract tests. Live upstream calls are optional and must not be required for `main` to stay green.
