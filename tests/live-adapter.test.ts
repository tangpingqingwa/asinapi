import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createAppAdapter } from "../src/adapters/index.js";
import {
  createLiveAmazonAdapter,
  liveProductUrl,
  liveReviewsUrl,
  liveSearchUrl,
  liveShortUrl,
  type LiveFetch,
} from "../src/adapters/amazon/live.js";
import { buildApp } from "../src/app.js";
import { getCredits } from "../src/billing/credits.js";
import { createKey } from "../src/billing/keys.js";
import { selectAmazonAdapter } from "../src/config.js";
import { openDatabase } from "../src/db.js";
import type { ErrorCode, Product, ReviewPage } from "../src/types.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HTML_DIR = join(ROOT, "tests/fixtures/html");
const KEY = "ak_test_live_adapter";
const BESTSELLER = "B0BESTSELL";
const BLOCKED = "B0BLOCKED0";
const FETCHED_AT = "2026-03-01T00:00:00.000Z";

type OkBody<T> = {
  data: T;
  meta: {
    cached: boolean;
    creditsCharged: number;
    requestId: string;
    upstreamMs: number;
  };
};

type ErrBody = {
  error: { code: ErrorCode; message: string; retryable: boolean };
  meta: { creditsCharged: number; requestId: string };
};

type MockCall = { url: string; method: string };

function fixtureHtml(name: string): string {
  return readFileSync(join(HTML_DIR, name), "utf8");
}

function responseWithUrl(
  body: string | null,
  url: string,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  const response = new Response(body, { status, headers });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

function createMockFetch(handler: LiveFetch): {
  fetch: LiveFetch;
  calls: MockCall[];
} {
  const calls: MockCall[] = [];
  return {
    calls,
    fetch: async (input, init) => {
      const url = String(input);
      if (/^https?:\/\/127\.0\.0\.1(?::|\/|$)/.test(url)) {
        throw new Error(`live adapter must not call loopback: ${url}`);
      }
      calls.push({
        url,
        method: (init?.method ?? "GET").toUpperCase(),
      });
      return handler(input, init);
    },
  };
}

function catalogFetch(): ReturnType<typeof createMockFetch> {
  return createMockFetch(async (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.hostname === "amzn.to") {
      if (url.pathname === "/Bests1") {
        return responseWithUrl(null, url.toString(), 301, {
          location: liveProductUrl(BESTSELLER),
        });
      }
      if (url.pathname === "/UkHost") {
        return responseWithUrl(null, url.toString(), 301, {
          location: `https://www.amazon.co.uk/dp/${BESTSELLER}`,
        });
      }
      if (url.pathname === "/Blocked") {
        return responseWithUrl("nope", url.toString(), 503);
      }
      if (url.pathname === "/Missing") {
        return responseWithUrl("gone", url.toString(), 404);
      }
      return responseWithUrl("unknown short", url.toString(), 404);
    }
    if (url.hostname === "www.amazon.co.uk") {
      return responseWithUrl("uk", url.toString(), 200);
    }
    if (url.hostname !== "www.amazon.com") {
      throw new Error(`unexpected host ${url.hostname}`);
    }
    if (method === "HEAD" && url.pathname === `/dp/${BESTSELLER}`) {
      return responseWithUrl(null, url.toString(), 200);
    }
    if (url.pathname === `/dp/${BESTSELLER}`) {
      return responseWithUrl(fixtureHtml("B0BESTSELL.html"), url.toString());
    }
    if (url.pathname === `/dp/${BLOCKED}`) {
      return responseWithUrl(fixtureHtml("B0BLOCKED0.html"), url.toString());
    }
    if (url.pathname === "/dp/B00NOTITLE") {
      return responseWithUrl(
        "<html><body><p>no productTitle here</p></body></html>",
        url.toString(),
      );
    }
    if (url.pathname === `/product-reviews/${BESTSELLER}`) {
      const page = url.searchParams.get("pageNumber") ?? "1";
      const sort = url.searchParams.get("sortBy") ?? "helpful";
      if (page === "1" && sort === "helpful") {
        return responseWithUrl(
          fixtureHtml("reviews/B0BESTSELL.p1.helpful.html"),
          url.toString(),
        );
      }
      return responseWithUrl(
        "<html><body><div id='cm_cr-review_list'></div></body></html>",
        url.toString(),
      );
    }
    if (url.pathname === "/s") {
      if (url.searchParams.get("k") === "blocked") {
        return responseWithUrl(fixtureHtml("search/blocked.p1.html"), url.toString());
      }
      if (url.searchParams.get("k") === "echo dot") {
        return responseWithUrl(
          fixtureHtml("search/echo-dot.p1.html"),
          url.toString(),
        );
      }
      return responseWithUrl(
        "<html><body><p>no results</p></body></html>",
        url.toString(),
      );
    }
    if (url.pathname.startsWith("/dp/")) {
      return responseWithUrl("missing", url.toString(), 404);
    }
    throw new Error(`unexpected live URL ${url.toString()}`);
  });
}

function liveAdapter(fetch: LiveFetch) {
  return createLiveAmazonAdapter({
    fetch,
    now: () => new Date(FETCHED_AT),
    env: { ASINAPI_FIXTURE_ONLY: "1" },
  });
}

async function appWithLive(credits = 10, fetch: LiveFetch) {
  const db = openDatabase(":memory:");
  createKey(db, { secret: KEY, credits });
  const app = await buildApp({
    db,
    adapter: liveAdapter(fetch),
  });
  after(async () => {
    await app.close();
    db.close();
  });
  return { app, db };
}

function auth() {
  return { authorization: `Bearer ${KEY}` };
}

test("selectAmazonAdapter defaults to fixture and FIXTURE_ONLY wins", () => {
  assert.equal(selectAmazonAdapter({}), "fixture");
  assert.equal(selectAmazonAdapter({ ASINAPI_ADAPTER: "fixture" }), "fixture");
  assert.equal(selectAmazonAdapter({ ASINAPI_ADAPTER: "LIVE" }), "live");
  assert.equal(
    selectAmazonAdapter({
      ASINAPI_ADAPTER: "live",
      ASINAPI_FIXTURE_ONLY: "1",
    }),
    "fixture",
  );
});

test("createAppAdapter stays on fixtures unless live is explicitly selected", async () => {
  const fixture = createAppAdapter({ env: {} });
  const forced = createAppAdapter({
    env: { ASINAPI_ADAPTER: "live", ASINAPI_FIXTURE_ONLY: "1" },
  });
  const live = createAppAdapter({
    env: { ASINAPI_ADAPTER: "live" },
    fetch: catalogFetch().fetch,
  });
  const fixtureResolved = await fixture.resolveShortCode("Bests1");
  const forcedResolved = await forced.resolveShortCode("Bests1");
  assert.equal(fixtureResolved.ok, true);
  assert.equal(forcedResolved.ok, true);
  assert.equal(
    createAppAdapter({
      env: { ASINAPI_ADAPTER: "live", ASINAPI_FIXTURE_ONLY: "1" },
    }).constructor.name,
    fixture.constructor.name,
  );
  const liveResolved = await live.resolveShortCode("Bests1");
  assert.equal(liveResolved.ok, true);
});

test("createLiveAmazonAdapter refuses a real fetch under ASINAPI_FIXTURE_ONLY=1", () => {
  assert.throws(
    () => createLiveAmazonAdapter({ env: { ASINAPI_FIXTURE_ONLY: "1" } }),
    /injected fetch/,
  );
});

test("live product parse uses checked-in HTML and does not invent a title", async () => {
  const mock = catalogFetch();
  const adapter = liveAdapter(mock.fetch);
  const result = await adapter.fetchProduct({ asin: BESTSELLER });
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.product.asin, BESTSELLER);
  assert.equal(result.product.marketplace, "US");
  assert.ok(result.product.title.includes("Echo Dot"));
  assert.equal(result.product.fetchedAt, FETCHED_AT);
  assert.ok(mock.calls.some((call) => call.url === liveProductUrl(BESTSELLER)));
  assert.ok(mock.calls.every((call) => call.method === "GET"));

  const missing = await adapter.fetchProduct({ asin: "B00NOTITLE" });
  assert.deepEqual(missing, { ok: false, code: "product_unavailable" });
});

test("live captcha HTML and 503 map to upstream_blocked", async () => {
  const mock = catalogFetch();
  const adapter = liveAdapter(mock.fetch);
  const captcha = await adapter.fetchProduct({ asin: BLOCKED });
  assert.deepEqual(captcha, { ok: false, code: "upstream_blocked" });

  const statusMock = createMockFetch(async (input) =>
    responseWithUrl("nope", String(input), 503),
  );
  const status = await liveAdapter(statusMock.fetch).fetchProduct({
    asin: BESTSELLER,
  });
  assert.deepEqual(status, { ok: false, code: "upstream_blocked" });
});

test("live 404 is product_unavailable; non-US host is marketplace_unsupported", async () => {
  const mock = catalogFetch();
  const adapter = liveAdapter(mock.fetch);
  const missing = await adapter.fetchProduct({ asin: "B00NOTHERE" });
  assert.deepEqual(missing, { ok: false, code: "product_unavailable" });

  const uk = await liveAdapter(
    createMockFetch(async (input) =>
      responseWithUrl(
        fixtureHtml("B0BESTSELL.html"),
        "https://www.amazon.co.uk/dp/B0BESTSELL",
      ),
    ).fetch,
  ).fetchProduct({
    asin: BESTSELLER,
    url: "https://www.amazon.co.uk/dp/B0BESTSELL",
  });
  assert.deepEqual(uk, { ok: false, code: "marketplace_unsupported" });
});

test("live adapter follows amzn.to with HEAD only", async () => {
  const mock = catalogFetch();
  const adapter = liveAdapter(mock.fetch);
  const resolved = await adapter.resolveShortCode("Bests1");
  assert.deepEqual(resolved, { ok: true, asin: BESTSELLER });
  assert.deepEqual(
    mock.calls.map((call) => `${call.method} ${call.url}`),
    [
      `HEAD ${liveShortUrl("Bests1")}`,
      `HEAD ${liveProductUrl(BESTSELLER)}`,
    ],
  );
});

test("live HEAD follow maps UK host, captcha, and missing short links", async () => {
  const mock = catalogFetch();
  const adapter = liveAdapter(mock.fetch);
  assert.deepEqual(await adapter.resolveShortCode("UkHost"), {
    ok: false,
    code: "marketplace_unsupported",
  });
  assert.deepEqual(await adapter.resolveShortCode("Blocked"), {
    ok: false,
    code: "upstream_blocked",
  });
  assert.deepEqual(await adapter.resolveShortCode("Missing"), {
    ok: false,
    code: "not_found",
  });
});

test("live reviews parse recorded HTML and never invent a hole", async () => {
  const mock = catalogFetch();
  const adapter = liveAdapter(mock.fetch);
  const page = await adapter.fetchReviews({
    asin: BESTSELLER,
    page: 1,
    sort: "helpful",
  });
  assert.equal(page.ok, true);
  if (!page.ok) {
    return;
  }
  assert.equal(page.page.reviews.length, 3);
  assert.deepEqual(
    page.page.reviews.map((review) => review.id),
    ["R10BESTHELP", "R11BESTHELP", "R12BESTHELP"],
  );
  assert.ok(
    mock.calls.some((call) =>
      call.url.startsWith(liveReviewsUrl(BESTSELLER, 1, "helpful")),
    ),
  );

  const empty = await adapter.fetchReviews({
    asin: BESTSELLER,
    page: 9,
    sort: "helpful",
  });
  assert.equal(empty.ok, true);
  if (empty.ok) {
    assert.deepEqual(empty.page, { page: 9, hasMore: false, reviews: [] });
  }
});

test("live search uses recorded HTML; captcha is upstream_blocked", async () => {
  const mock = catalogFetch();
  const adapter = liveAdapter(mock.fetch);
  const page = await adapter.fetchSearch({ q: "echo dot", page: 1 });
  assert.equal(page.ok, true);
  if (page.ok) {
    assert.equal(page.page.results.length, 2);
    assert.equal(page.page.results[0]?.asin, BESTSELLER);
  }
  assert.ok(mock.calls.some((call) => call.url === liveSearchUrl("echo dot", 1)));

  const blocked = await adapter.fetchSearch({ q: "blocked", page: 1 });
  assert.deepEqual(blocked, { ok: false, code: "upstream_blocked" });
});

test("HTTP live by-url HEAD-follows amzn.to, charges 1, and stays honest", async () => {
  const mock = catalogFetch();
  const { app, db } = await appWithLive(5, mock.fetch);
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);

  const response = await app.inject({
    method: "GET",
    url: `/v1/products/by-url?url=${encodeURIComponent("https://amzn.to/Bests1")}`,
    headers: auth(),
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as OkBody<Product>;
  assert.equal(body.data.asin, BESTSELLER);
  assert.ok(body.data.title.includes("Echo Dot"));
  assert.equal(body.data.fetchedAt, FETCHED_AT);
  assert.equal(body.meta.creditsCharged, 1);
  assert.equal(getCredits(db, keyRow.id), 4);
  assert.ok(mock.calls.some((call) => call.method === "HEAD"));
});

test("HTTP live failures map to SPEC codes and charge 0", async () => {
  const mock = catalogFetch();
  const { app, db } = await appWithLive(6, mock.fetch);
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);

  const blocked = await app.inject({
    method: "GET",
    url: `/v1/products/${BLOCKED}`,
    headers: auth(),
  });
  assert.equal(blocked.statusCode, 503);
  assert.equal((blocked.json() as ErrBody).error.code, "upstream_blocked");
  assert.equal((blocked.json() as ErrBody).meta.creditsCharged, 0);

  const uk = await app.inject({
    method: "GET",
    url: `/v1/products/by-url?url=${encodeURIComponent("https://amzn.to/UkHost")}`,
    headers: auth(),
  });
  assert.equal(uk.statusCode, 422);
  assert.equal((uk.json() as ErrBody).error.code, "marketplace_unsupported");
  assert.equal((uk.json() as ErrBody).meta.creditsCharged, 0);

  const missingTitle = await app.inject({
    method: "GET",
    url: "/v1/products/B00NOTITLE",
    headers: auth(),
  });
  assert.equal(missingTitle.statusCode, 404);
  assert.equal((missingTitle.json() as ErrBody).error.code, "product_unavailable");
  assert.equal((missingTitle.json() as ErrBody).meta.creditsCharged, 0);

  assert.equal(getCredits(db, keyRow.id), 6);
});

test("HTTP live reviews never invent rows and empty pages stay empty", async () => {
  const mock = catalogFetch();
  const { app } = await appWithLive(4, mock.fetch);
  const first = await app.inject({
    method: "GET",
    url: `/v1/products/${BESTSELLER}/reviews`,
    headers: auth(),
  });
  assert.equal(first.statusCode, 200);
  const body = first.json() as OkBody<ReviewPage>;
  assert.equal(body.data.reviews.length, 3);
  assert.equal(body.meta.creditsCharged, 1);

  const empty = await app.inject({
    method: "GET",
    url: `/v1/products/${BESTSELLER}/reviews?page=9`,
    headers: auth(),
  });
  assert.equal(empty.statusCode, 200);
  assert.deepEqual((empty.json() as OkBody<ReviewPage>).data, {
    page: 9,
    hasMore: false,
    reviews: [],
  });
});

test("live adapter source does not consult the fixture short-link map", () => {
  const src = readFileSync(
    join(ROOT, "src/adapters/amazon/live.ts"),
    "utf8",
  );
  assert.doesNotMatch(src, /short-links\.json/);
  assert.match(src, /method:\s*"HEAD"/);
});
