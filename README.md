# AsinAPI

Build contract: [SPEC.md](./SPEC.md).
How we work: [CONTRIBUTING.md](./CONTRIBUTING.md). `main` stays buildable and testable.
How we build: [BUILD.md](./BUILD.md) — stack, modules, tests, PR sequence.

Amazon product records and reviews by ASIN or URL. One REST call, typed JSON.

Amazon’s Product Advertising API is real and unusable for most builders: you need an Associates account that already sells. The demand did not leave.

## Why this, and why overseas

US Amazon is the default product database for price trackers, affiliate sites, AI shopping agents, and review miners. Keepa, Rainforest, Axesso already charge for this, which is the point — the category clears money. A 2026 opening is the same one Shimecki took on Zillow: same-day signup, credits, MCP, no “apply and wait.”

Queries: `amazon product api`, `amazon reviews api`, `asin api`, `product advertising api alternative`.

## Exact demand

- Who: affiliate sites, purchase agents, review summarizers, own tools that need a buy link
- Input: ASIN, Amazon URL, or category search
- Output: title, price, currency, rating, image URLs, bullets, BSR if present, review pages
- Acceptance: `GET /v1/products/{asin}` → 300+ typed fields or a honest subset; reviews paginated; failures 0 credits

## Exact connector

| Endpoint | Job | Credits |
|---|---|---|
| `/v1/products/by-url` | Full product | 1 |
| `/v1/products/{asin}` | Full product | 1 |
| `/v1/products/{asin}/reviews` | Review page | 1 / page |
| `/v1/search` | Keyword / category | 1 / result |
| `/v1/products/{asin}/offers` | Buy-box / other sellers if stable | 2 |

US marketplace first (`.com`). UK / DE only after US cache and selectors are boring.

OpenAPI, MCP (`get_product`, `list_reviews`, `search_amazon`), `llms.txt`.

## Exact combination

- Evergreen: `Amazon Product Advertising API requirements in 2026`
- 100 free credits, no card
- Price above ClipAPI: this proxy bill is real. Start $19 / mo / 2,000, top-ups published
- Agent pitch: “price and reviews for this ASIN, then draft a buying note”
- Do not build a consumer storefront

## Cost control

- Product pages: cache 6–24h; price-sensitive fields may be shorter
- Reviews: cache by `(asin, page, sort)`
- Images as URLs, never hotlink-host Amazon media
- Failed CAPTCHA / 503: 0 credits, reason `upstream_blocked`
- Proxy spend on a weekly dashboard; if it crosses 25% of revenue, raise credits or cut search

## Business model

Credits. Sell a stable v1, not “cheaper than Keepa on every dimension.” Win on: signup today, MCP, predictable errors.

Success: 15 paying keys (affiliates or agents); proxy + host < 25% of revenue; US catalog p95 useful (not empty).

## Will not do

- No cart, checkout, or Buy with Prime
- No fake BSR history graphs in v1 (Keepa’s moat; do not lie)
- No 20-marketplace launch
- No review generation

## First two weeks

1. US product-by-ASIN + review page 1
2. Field list frozen in OpenAPI
3. 50-ASIN fixture set; layout change fails CI
4. MCP `get_product`

## Dogfood

Any future affiliate experiment and DailyBrief’s “products mentioned in this video” resolution go through AsinAPI. If we still view-source Amazon, the API is not done.

## Risk

Amazon ToS and bot fighting are the job. Read-only public listing data. Customer terms: no account takeover, no review fraud. If Associates PA-API becomes easy again, shrink to a friendlier facade rather than die on principle.
