import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createFixtureAdapter,
  parseReviewsHtml,
} from "../src/adapters/amazon/fixture.js";
import type {
  ProductAdapter,
  ReviewsAdapterResult,
} from "../src/adapters/types.js";
import { buildApp } from "../src/app.js";
import { getCredits } from "../src/billing/credits.js";
import { createKey } from "../src/billing/keys.js";
import { parseReviewPage, parseReviewSort } from "../src/core/reviews.js";
import { openDatabase } from "../src/db.js";
import {
  REVIEW_FIELDS,
  REVIEW_PAGE_FIELDS,
  type ErrorCode,
  type Review,
  type ReviewPage,
} from "../src/types.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = "ak_test_reviews_fixture";
const BESTSELLER = "B0BESTSELL";
const BOOK = "B0BOOK0001";
const UNAVAILABLE = "B0UNAVAIL0";
const VARIATION = "B0VARIATN1";
const ADULT = "B0ADULTADJ";
const BLOCKED = "B0BLOCKED0";
const EMPTY = "B0NOREVIEW";

const BESTSELLER_HELPFUL_IDS = ["R10BESTHELP", "R11BESTHELP", "R12BESTHELP"] as const;
const BESTSELLER_RECENT_IDS = ["R20BESTREC", "R21BESTREC"] as const;

type OkBody = {
  data: ReviewPage;
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

type AsinFixture = {
  asin: string;
  hasReviews: boolean;
};

async function appWithKey(credits = 100, adapter?: ProductAdapter) {
  const db = openDatabase(":memory:");
  createKey(db, { secret: KEY, credits });
  const app = await buildApp({
    db,
    adapter: adapter ?? createFixtureAdapter(),
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

function loadAsins(): AsinFixture[] {
  return JSON.parse(
    readFileSync(join(ROOT, "tests/fixtures/asins.json"), "utf8"),
  ) as AsinFixture[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertReviewShape(review: Review): void {
  for (const field of REVIEW_FIELDS) {
    assert.ok(field in review, `missing ${field}`);
  }
  assert.ok(review.id === null || typeof review.id === "string");
  assert.ok(review.title === null || typeof review.title === "string");
  assert.equal(typeof review.body, "string");
  assert.equal(typeof review.stars, "number");
  assert.ok(review.stars >= 1 && review.stars <= 5);
  assert.ok(review.createdAt === null || typeof review.createdAt === "string");
  assert.ok(
    review.verified === null || typeof review.verified === "boolean",
  );
  assert.ok(review.author === null || typeof review.author === "string");
  assert.ok(review.country === null || typeof review.country === "string");
}

function assertReviewPageShape(page: ReviewPage): void {
  for (const field of REVIEW_PAGE_FIELDS) {
    assert.ok(field in page, `missing ${field}`);
  }
  assert.equal(typeof page.page, "number");
  assert.ok(page.page >= 1);
  assert.equal(typeof page.hasMore, "boolean");
  assert.ok(Array.isArray(page.reviews));
  for (const review of page.reviews) {
    assertReviewShape(review);
  }
}

function reviewBodies(page: ReviewPage): string[] {
  return page.reviews.map((review) => review.body);
}

test("parseReviewPage is 1-based and rejects zero, floats, and junk", () => {
  assert.equal(parseReviewPage(undefined), 1);
  assert.equal(parseReviewPage(""), 1);
  assert.equal(parseReviewPage("1"), 1);
  assert.equal(parseReviewPage(2), 2);
  assert.equal(parseReviewPage("12"), 12);
  assert.equal(parseReviewPage("0"), null);
  assert.equal(parseReviewPage("-1"), null);
  assert.equal(parseReviewPage("1.5"), null);
  assert.equal(parseReviewPage("page"), null);
  assert.equal(parseReviewPage(0), null);
});

test("parseReviewSort defaults to helpful and rejects unknown values", () => {
  assert.equal(parseReviewSort(undefined), "helpful");
  assert.equal(parseReviewSort(""), "helpful");
  assert.equal(parseReviewSort("helpful"), "helpful");
  assert.equal(parseReviewSort("recent"), "recent");
  assert.equal(parseReviewSort("top"), null);
  assert.equal(parseReviewSort("HELPFUL"), null);
});

test("representative review HTML fixtures parse only recorded reviews", () => {
  const reviewsDir = join(ROOT, "tests/fixtures/html/reviews");
  const files = {
    [BESTSELLER]: "B0BESTSELL.p1.helpful.html",
    [BOOK]: "B0BOOK0001.p1.helpful.html",
    [VARIATION]: "B0VARIATN1.p1.helpful.html",
    [ADULT]: "B0ADULTADJ.p1.helpful.html",
    [EMPTY]: "B0NOREVIEW.p1.helpful.html",
  };
  for (const [asin, file] of Object.entries(files)) {
    assert.ok(readdirSync(reviewsDir).includes(file), file);
    const html = readFileSync(join(reviewsDir, file), "utf8");
    const result = parseReviewsHtml(1, html);
    assert.equal(result.ok, true, asin);
    if (!result.ok) {
      continue;
    }
    assertReviewPageShape(result.page);
    assert.equal(result.page.page, 1);
    if (asin === EMPTY) {
      assert.deepEqual(result.page.reviews, []);
      assert.equal(result.page.hasMore, false);
      continue;
    }
    assert.ok(result.page.reviews.length >= 1, asin);
    for (const review of result.page.reviews) {
      assert.ok(review.body.length > 0, review.id ?? asin);
    }
  }
});

test("review parser never synthesizes a review from a hole in the HTML", () => {
  const html = readFileSync(
    join(ROOT, "tests/fixtures/html/reviews/B0BESTSELL.p1.helpful.html"),
    "utf8",
  );
  const full = parseReviewsHtml(1, html);
  assert.equal(full.ok, true);
  if (!full.ok) {
    return;
  }
  assert.equal(full.page.reviews.length, 3);
  assert.deepEqual(
    full.page.reviews.map((review) => review.id),
    [...BESTSELLER_HELPFUL_IDS],
  );

  const hole = html.replace(
    /<article data-hook="review" data-review-id="R11BESTHELP"[\s\S]*?<\/article>/,
    "",
  );
  const gapped = parseReviewsHtml(1, hole);
  assert.equal(gapped.ok, true);
  if (!gapped.ok) {
    return;
  }
  assert.equal(gapped.page.reviews.length, 2);
  assert.deepEqual(
    gapped.page.reviews.map((review) => review.id),
    ["R10BESTHELP", "R12BESTHELP"],
  );
  assert.equal(
    gapped.page.reviews.some((review) => review.id === "R11BESTHELP"),
    false,
  );
});

test("SPEC 4: review page 1 returns recorded reviews, never fakes, 1 credit", async () => {
  const { app, db } = await appWithKey(10);
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);

  const response = await app.inject({
    method: "GET",
    url: `/v1/products/${BESTSELLER}/reviews`,
    headers: auth(),
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as OkBody;
  assertReviewPageShape(body.data);
  assert.equal(body.data.page, 1);
  assert.equal(body.data.hasMore, true);
  assert.ok(body.data.reviews.length >= 1);
  assert.deepEqual(
    body.data.reviews.map((review) => review.id),
    [...BESTSELLER_HELPFUL_IDS],
  );
  assert.equal(body.data.reviews[0]?.stars, 5);
  assert.equal(body.data.reviews[0]?.verified, true);
  assert.equal(body.data.reviews[0]?.author, "Alex M.");
  assert.equal(body.data.reviews[0]?.country, "United States");
  assert.equal(
    body.data.reviews[0]?.body.includes("kitchen timers"),
    true,
  );
  assert.equal(body.data.reviews[2]?.verified, null);
  assert.equal(body.meta.cached, false);
  assert.equal(body.meta.creditsCharged, 1);
  assert.match(body.meta.requestId, /^req_/);
  assert.equal(getCredits(db, keyRow.id), 9);
});

test("lowercase ASIN reviews are uppercased and billed once", async () => {
  const { app } = await appWithKey();
  const response = await app.inject({
    method: "GET",
    url: `/v1/products/${BESTSELLER.toLowerCase()}/reviews`,
    headers: auth(),
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as OkBody;
  assert.equal(body.data.page, 1);
  assert.ok(body.data.reviews.length >= 1);
  assert.equal(body.meta.creditsCharged, 1);
});

test("empty recorded review page is 200 { reviews: [], hasMore: false }", async () => {
  const { app, db } = await appWithKey(5);
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);

  const response = await app.inject({
    method: "GET",
    url: `/v1/products/${EMPTY}/reviews`,
    headers: auth(),
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as OkBody;
  assert.deepEqual(body.data, { page: 1, hasMore: false, reviews: [] });
  assert.equal(body.meta.creditsCharged, 1);
  assert.equal(getCredits(db, keyRow.id), 4);
});

test("page 2 returns only the recorded second page, never padded", async () => {
  const { app } = await appWithKey();
  const response = await app.inject({
    method: "GET",
    url: `/v1/products/${BESTSELLER}/reviews?page=2&sort=helpful`,
    headers: auth(),
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as OkBody;
  assert.equal(body.data.page, 2);
  assert.equal(body.data.hasMore, false);
  assert.deepEqual(
    body.data.reviews.map((review) => review.id),
    ["R30BESTP2"],
  );
  assert.equal(
    body.data.reviews[0]?.body.includes("Do not invent extra reviews"),
    true,
  );
});

test("page beyond recorded fixtures is 200 empty, not 404 and not invented", async () => {
  const { app } = await appWithKey();
  const response = await app.inject({
    method: "GET",
    url: `/v1/products/${BESTSELLER}/reviews?page=99`,
    headers: auth(),
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as OkBody;
  assert.deepEqual(body.data, { page: 99, hasMore: false, reviews: [] });
  assert.equal(body.meta.creditsCharged, 1);
});

test("sort=recent returns the recorded recent page, not the helpful one", async () => {
  const { app } = await appWithKey();
  const helpful = await app.inject({
    method: "GET",
    url: `/v1/products/${BESTSELLER}/reviews?sort=helpful`,
    headers: auth(),
  });
  const recent = await app.inject({
    method: "GET",
    url: `/v1/products/${BESTSELLER}/reviews?sort=recent`,
    headers: auth(),
  });
  assert.equal(helpful.statusCode, 200);
  assert.equal(recent.statusCode, 200);
  const helpfulBody = helpful.json() as OkBody;
  const recentBody = recent.json() as OkBody;
  assert.deepEqual(
    helpfulBody.data.reviews.map((review) => review.id),
    [...BESTSELLER_HELPFUL_IDS],
  );
  assert.deepEqual(
    recentBody.data.reviews.map((review) => review.id),
    [...BESTSELLER_RECENT_IDS],
  );
  assert.notDeepEqual(reviewBodies(recentBody.data), reviewBodies(helpfulBody.data));
  assert.equal(recentBody.data.hasMore, false);
});

test("book, variation, and adult-adjacent page 1 stay honest", async () => {
  const { app } = await appWithKey();
  const cases = [
    { asin: BOOK, needle: "two flights" },
    { asin: VARIATION, needle: "No child ASINs" },
    { asin: ADULT, needle: "never 500" },
  ];
  for (const { asin, needle } of cases) {
    const response = await app.inject({
      method: "GET",
      url: `/v1/products/${asin}/reviews`,
      headers: auth(),
    });
    assert.equal(response.statusCode, 200, asin);
    const body = response.json() as OkBody;
    assertReviewPageShape(body.data);
    assert.ok(body.data.reviews.length >= 1, asin);
    assert.ok(
      body.data.reviews.some((review) => review.body.includes(needle)),
      asin,
    );
  }
});

test("invalid page or sort is 400 invalid_request and 0 credit", async () => {
  const { app, db } = await appWithKey(5);
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);

  const cases = [
    `/v1/products/${BESTSELLER}/reviews?page=0`,
    `/v1/products/${BESTSELLER}/reviews?page=-1`,
    `/v1/products/${BESTSELLER}/reviews?page=1.5`,
    `/v1/products/${BESTSELLER}/reviews?sort=top`,
  ];
  for (const url of cases) {
    const response = await app.inject({
      method: "GET",
      url,
      headers: auth(),
    });
    assert.equal(response.statusCode, 400, url);
    const body = response.json() as ErrBody;
    assert.equal(body.error.code, "invalid_request");
    assert.equal(body.meta.creditsCharged, 0);
  }
  assert.equal(getCredits(db, keyRow.id), 5);
});

test("garbage ASIN reviews is 400 invalid_asin and 0 credit", async () => {
  const { app, db } = await appWithKey(5);
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);
  const response = await app.inject({
    method: "GET",
    url: "/v1/products/nope/reviews",
    headers: auth(),
  });
  assert.equal(response.statusCode, 400);
  const body = response.json() as ErrBody;
  assert.equal(body.error.code, "invalid_asin");
  assert.equal(body.meta.creditsCharged, 0);
  assert.equal(getCredits(db, keyRow.id), 5);
});

test("unavailable product reviews is 404 product_unavailable and 0 credit", async () => {
  const { app, db } = await appWithKey(5);
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);
  const response = await app.inject({
    method: "GET",
    url: `/v1/products/${UNAVAILABLE}/reviews`,
    headers: auth(),
  });
  assert.equal(response.statusCode, 404);
  const body = response.json() as ErrBody;
  assert.equal(body.error.code, "product_unavailable");
  assert.equal(body.meta.creditsCharged, 0);
  assert.equal(getCredits(db, keyRow.id), 5);
});

test("unknown catalog ASIN reviews is 404 and 0 credit", async () => {
  const { app, db } = await appWithKey(3);
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);
  const response = await app.inject({
    method: "GET",
    url: "/v1/products/B00NOTHERE/reviews",
    headers: auth(),
  });
  assert.equal(response.statusCode, 404);
  assert.equal((response.json() as ErrBody).error.code, "product_unavailable");
  assert.equal(getCredits(db, keyRow.id), 3);
});

test("repeat review page is cached and still charges 1", async () => {
  const { app, db } = await appWithKey(10);
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);

  const first = await app.inject({
    method: "GET",
    url: `/v1/products/${BESTSELLER}/reviews?page=1&sort=helpful`,
    headers: auth(),
  });
  assert.equal(first.statusCode, 200);
  const firstBody = first.json() as OkBody;
  assert.equal(firstBody.meta.cached, false);

  const started = performance.now();
  const second = await app.inject({
    method: "GET",
    url: `/v1/products/${BESTSELLER.toLowerCase()}/reviews?page=1&sort=helpful`,
    headers: auth(),
  });
  const elapsedMs = performance.now() - started;
  assert.equal(second.statusCode, 200);
  const secondBody = second.json() as OkBody;
  assert.equal(secondBody.meta.cached, true);
  assert.equal(secondBody.meta.creditsCharged, 1);
  assert.equal(secondBody.meta.upstreamMs, 0);
  assert.deepEqual(secondBody.data, firstBody.data);
  assert.ok(elapsedMs < 80, `cache hit took ${elapsedMs}ms`);
  assert.equal(getCredits(db, keyRow.id), 8);
});

test("empty key is 401; credits = 0 is 402 before adapter work", async () => {
  const { app, db } = await appWithKey(0);
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);

  const unauth = await app.inject({
    method: "GET",
    url: `/v1/products/${BESTSELLER}/reviews`,
  });
  assert.equal(unauth.statusCode, 401);
  assert.equal((unauth.json() as ErrBody).error.code, "unauthorized");
  assert.equal((unauth.json() as ErrBody).meta.creditsCharged, 0);

  const broke = await app.inject({
    method: "GET",
    url: `/v1/products/${BESTSELLER}/reviews`,
    headers: auth(),
  });
  assert.equal(broke.statusCode, 402);
  assert.equal((broke.json() as ErrBody).error.code, "payment_required");
  assert.equal((broke.json() as ErrBody).meta.creditsCharged, 0);
  assert.equal(getCredits(db, keyRow.id), 0);
  const cached = db
    .prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM cache_entries")
    .get();
  assert.equal(cached?.n, 0);
});

test("forced adapter 503 on reviews is upstream_blocked and 0 credit", async () => {
  const blocked: ProductAdapter = {
    resolveShortCode() {
      return { ok: false, code: "not_found" };
    },
    async fetchProduct() {
      return { ok: false, code: "upstream_blocked" };
    },
    async fetchReviews(): Promise<ReviewsAdapterResult> {
      return { ok: false, code: "upstream_blocked" };
    },
    async fetchSearch() {
      return { ok: false, code: "upstream_blocked" as const };
    },
  };
  const { app, db } = await appWithKey(4, blocked);
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);

  const response = await app.inject({
    method: "GET",
    url: `/v1/products/${BESTSELLER}/reviews`,
    headers: auth(),
  });
  assert.equal(response.statusCode, 503);
  const body = response.json() as ErrBody;
  assert.equal(body.error.code, "upstream_blocked");
  assert.equal(body.error.retryable, true);
  assert.equal(body.meta.creditsCharged, 0);
  assert.equal(getCredits(db, keyRow.id), 4);
});

test("captcha review HTML is upstream_blocked without charging", () => {
  const html = readFileSync(
    join(ROOT, "tests/fixtures/html/B0BLOCKED0.html"),
    "utf8",
  );
  assert.deepEqual(parseReviewsHtml(1, html), {
    ok: false,
    code: "upstream_blocked",
  });
});

test("blocked product fixture does not invent reviews", async () => {
  const { app, db } = await appWithKey(4);
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);
  const response = await app.inject({
    method: "GET",
    url: `/v1/products/${BLOCKED}/reviews`,
    headers: auth(),
  });
  assert.equal(response.statusCode, 503);
  const body = response.json() as ErrBody;
  assert.equal(body.error.code, "upstream_blocked");
  assert.equal(body.meta.creditsCharged, 0);
  assert.equal(getCredits(db, keyRow.id), 4);
});

test("asins.json hasReviews is not used to invent review rows", () => {
  const asins = loadAsins();
  const withFlag = asins.filter((row) => row.hasReviews);
  assert.ok(withFlag.length > 0);
  const reviewsDir = join(ROOT, "tests/fixtures/html/reviews");
  const recorded = new Set(
    readdirSync(reviewsDir)
      .filter((name) => name.endsWith(".html"))
      .map((name) => name.slice(0, 10).toUpperCase()),
  );
  for (const row of withFlag) {
    if (!recorded.has(row.asin)) {
      continue;
    }
    const html = readFileSync(
      join(reviewsDir, `${row.asin}.p1.helpful.html`),
      "utf8",
    );
    const result = parseReviewsHtml(1, html);
    assert.equal(result.ok, true, row.asin);
    if (result.ok) {
      assert.ok(result.page.reviews.length >= 1, row.asin);
    }
  }
});

test("HTTP review route calls core only and never imports adapters/amazon", () => {
  const src = readFileSync(
    join(ROOT, "src/http/routes/products.ts"),
    "utf8",
  );
  assert.match(src, /getReviews/);
  assert.doesNotMatch(src, /adapters\/amazon/);
});

test("no live Amazon review hosts are fetched from src or tests", () => {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, name.name);
      if (name.isDirectory()) {
        walk(path);
      } else if (name.name.endsWith(".ts")) {
        files.push(path);
      }
    }
  };
  walk(join(ROOT, "src"));
  walk(join(ROOT, "tests"));
  for (const file of files) {
    if (file.endsWith("/adapters/amazon/live.ts")) {
      continue;
    }
    if (file.endsWith("/live-adapter.test.ts")) {
      continue;
    }
    const src = readFileSync(file, "utf8");
    assert.doesNotMatch(
      src,
      /\bfetch\s*\(\s*['"`]https?:\/\/[^'"`]*amazon/i,
      file,
    );
    assert.doesNotMatch(src, /product-reviews\/[^"'`]+\/ref=/i, file);
  }
});

test("OpenAPI freezes the review page shape; offers stay 501", () => {
  const spec = readFileSync(join(ROOT, "openapi/openapi.yaml"), "utf8");
  assert.match(spec, /\/v1\/products\/\{asin\}\/reviews/);
  assert.match(spec, /operationId: getProductReviews/);
  for (const field of REVIEW_PAGE_FIELDS) {
    assert.match(spec, new RegExp(`^        ${field}:`, "m"), field);
  }
  for (const field of REVIEW_FIELDS) {
    assert.match(spec, new RegExp(`^        ${field}:`, "m"), field);
  }
  assert.match(spec, /enum:\n\s+- helpful\n\s+- recent/);
  assert.match(spec, /\/v1\/search/);
  assert.match(spec, /\/v1\/products\/\{asin\}\/offers/);
  assert.match(spec, /not_implemented/);
});

test("fixture review payloads satisfy the frozen ReviewPage shape", async () => {
  const { app } = await appWithKey();
  const response = await app.inject({
    method: "GET",
    url: `/v1/products/${BESTSELLER}/reviews`,
    headers: auth(),
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as OkBody;
  assertReviewPageShape(body.data);
  const extraPage = Object.keys(body.data).filter(
    (key) => !(REVIEW_PAGE_FIELDS as readonly string[]).includes(key),
  );
  assert.deepEqual(extraPage, []);
  const extraReview = Object.keys(body.data.reviews[0] ?? {}).filter(
    (key) => !(REVIEW_FIELDS as readonly string[]).includes(key),
  );
  assert.deepEqual(extraReview, []);
  assert.ok(isRecord(body.data.reviews[0]));
});
