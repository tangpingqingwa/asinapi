import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createFixtureAdapter,
  parseProductHtml,
} from "../src/adapters/amazon/fixture.js";
import type { AdapterResult, ProductAdapter } from "../src/adapters/types.js";
import { buildApp } from "../src/app.js";
import { getCredits } from "../src/billing/credits.js";
import { createKey } from "../src/billing/keys.js";
import { normalizeAsin, parseAmazonUrl } from "../src/core/product.js";
import { openDatabase } from "../src/db.js";
import {
  ERROR_CODES,
  PRODUCT_FIELDS,
  type ErrorCode,
  type Product,
} from "../src/types.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = "ak_test_product_fixture";
const BESTSELLER = "B0BESTSELL";
const BOOK = "B0BOOK0001";
const UNAVAILABLE = "B0UNAVAIL0";
const VARIATION = "B0VARIATN1";
const ADULT = "B0ADULTADJ";
const BLOCKED = "B0BLOCKED0";

type OkBody = {
  data: Product;
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
  titlePresent: boolean;
  unavailable: boolean;
  hasReviews: boolean;
  kind: string;
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

function assertProductShape(product: Product): void {
  for (const field of PRODUCT_FIELDS) {
    assert.ok(field in product, `missing ${field}`);
  }
  assert.match(product.asin, /^[A-Z0-9]{10}$/);
  assert.equal(product.marketplace, "US");
  assert.equal(typeof product.title, "string");
  assert.ok(product.title.length > 0);
  assert.ok(Array.isArray(product.images));
  assert.ok(product.images.length <= 10);
  assert.equal(product.price.currency, "USD");
  assert.equal(typeof product.price.unavailable, "boolean");
  assert.ok(Array.isArray(product.bullets));
  assert.ok(Array.isArray(product.categoryPath));
  assert.ok(isRecord(product.attributes));
  assert.equal(typeof product.fetchedAt, "string");
}

function usefulProduct(product: Product): boolean {
  const hasImage = product.images.length > 0;
  const hasRating =
    product.rating.average !== null || product.rating.count !== null;
  const hasPrice = product.price.amount !== null || product.price.unavailable;
  return product.title.length > 0 && hasImage && (hasRating || hasPrice);
}

test("50-ASIN catalog lists expected flags and unique US ASINs", () => {
  const asins = loadAsins();
  assert.equal(asins.length, 50);
  const seen = new Set<string>();
  for (const row of asins) {
    assert.match(row.asin, /^[A-Z0-9]{10}$/, row.asin);
    assert.equal(seen.has(row.asin), false, row.asin);
    seen.add(row.asin);
    assert.equal(typeof row.titlePresent, "boolean");
    assert.equal(typeof row.unavailable, "boolean");
    assert.equal(typeof row.hasReviews, "boolean");
    if (row.unavailable) {
      assert.equal(row.titlePresent, false);
    }
  }
  const kinds = new Set(asins.map((row) => row.kind));
  for (const kind of [
    "commodity",
    "book",
    "unavailable",
    "variation_parent",
    "adult_adjacent",
  ]) {
    assert.ok(kinds.has(kind), kind);
  }
});

test("normalizeAsin uppercases valid input and rejects garbage", () => {
  assert.equal(normalizeAsin("b0bestsell"), BESTSELLER);
  assert.equal(normalizeAsin("B0BESTSELL"), BESTSELLER);
  assert.equal(normalizeAsin("  b0bestsell  "), BESTSELLER);
  assert.equal(normalizeAsin("nope"), null);
  assert.equal(normalizeAsin("B0SHORT"), null);
  assert.equal(normalizeAsin("B0TOO-LONGX"), null);
  assert.equal(normalizeAsin(""), null);
});

test("parseAmazonUrl accepts /dp/, /gp/product/, and asin= query", () => {
  const urls = [
    `https://www.amazon.com/dp/${BESTSELLER}`,
    `https://amazon.com/dp/${BESTSELLER}/`,
    `https://www.amazon.com/Echo-Dot/dp/${BESTSELLER}?th=1`,
    `https://www.amazon.com/gp/product/${BESTSELLER}`,
    `https://smile.amazon.com/gp/product/${BESTSELLER}/ref=xx`,
    `https://www.amazon.com/s?k=speaker&asin=${BESTSELLER}`,
    `www.amazon.com/dp/${BESTSELLER.toLowerCase()}`,
  ];
  for (const url of urls) {
    const parsed = parseAmazonUrl(url);
    assert.equal(parsed.ok, true, url);
    if (parsed.ok) {
      assert.equal(parsed.kind, "asin");
      if (parsed.kind === "asin") {
        assert.equal(parsed.asin, BESTSELLER);
      }
    }
  }
});

test("parseAmazonUrl maps amzn.to to a short code without fetching", () => {
  const parsed = parseAmazonUrl("https://amzn.to/Bests1");
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.kind, "short");
    if (parsed.kind === "short") {
      assert.equal(parsed.code, "Bests1");
    }
  }
});

test("parseAmazonUrl rejects non-US hosts before any fetch", () => {
  const hosts = [
    "https://www.amazon.co.uk/dp/B0BESTSELL",
    "https://amazon.de/dp/B0BESTSELL",
    "https://www.amazon.co.jp/gp/product/B0BESTSELL",
    "https://amazon.fr/dp/B0BESTSELL",
  ];
  for (const url of hosts) {
    const parsed = parseAmazonUrl(url);
    assert.equal(parsed.ok, false, url);
    if (!parsed.ok) {
      assert.equal(parsed.code, "marketplace_unsupported");
    }
  }
});

test("representative HTML fixtures parse; dropping title fails", () => {
  const htmlDir = join(ROOT, "tests/fixtures/html");
  const files = {
    [BESTSELLER]: "B0BESTSELL.html",
    [BOOK]: "B0BOOK0001.html",
    [UNAVAILABLE]: "B0UNAVAIL0.html",
    [VARIATION]: "B0VARIATN1.html",
    [ADULT]: "B0ADULTADJ.html",
    [BLOCKED]: "B0BLOCKED0.html",
  };
  for (const [asin, file] of Object.entries(files)) {
    assert.ok(readdirSync(htmlDir).includes(file), file);
    const html = readFileSync(join(htmlDir, file), "utf8");
    const result = parseProductHtml(asin, html);
    if (asin === UNAVAILABLE) {
      assert.deepEqual(result, { ok: false, code: "product_unavailable" });
      continue;
    }
    if (asin === BLOCKED) {
      assert.deepEqual(result, { ok: false, code: "upstream_blocked" });
      continue;
    }
    assert.equal(result.ok, true, asin);
    if (result.ok) {
      assertProductShape(result.product);
      assert.ok(usefulProduct(result.product), asin);
    }
  }

  const stripped = readFileSync(
    join(htmlDir, "B0BESTSELL.html"),
    "utf8",
  ).replace(/id=["']productTitle["'][\s\S]*?<\/span>/, "");
  const missingTitle = parseProductHtml(BESTSELLER, stripped);
  assert.deepEqual(missingTitle, { ok: false, code: "product_unavailable" });
});

test("SPEC 1: well-known ASIN returns title + image + rating or price and 1 credit", async () => {
  const { app, db } = await appWithKey(10);
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);

  const response = await app.inject({
    method: "GET",
    url: `/v1/products/${BESTSELLER}`,
    headers: auth(),
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as OkBody;
  assertProductShape(body.data);
  assert.ok(usefulProduct(body.data));
  assert.equal(body.data.asin, BESTSELLER);
  assert.equal(body.data.title.includes("Echo Dot"), true);
  assert.equal(body.data.price.amount, 49.99);
  assert.equal(body.data.price.unavailable, false);
  assert.equal(body.data.rating.average, 4.7);
  assert.ok(body.data.images[0]?.startsWith("https://"));
  assert.equal(body.meta.cached, false);
  assert.equal(body.meta.creditsCharged, 1);
  assert.match(body.meta.requestId, /^req_/);
  assert.equal(getCredits(db, keyRow.id), 9);
});

test("lowercase ASIN is uppercased and billed once", async () => {
  const { app } = await appWithKey();
  const response = await app.inject({
    method: "GET",
    url: `/v1/products/${BESTSELLER.toLowerCase()}`,
    headers: auth(),
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as OkBody;
  assert.equal(body.data.asin, BESTSELLER);
  assert.equal(body.meta.creditsCharged, 1);
});

test("SPEC 2: by-url amazon.com/dp/{asin} matches GET by ASIN", async () => {
  const { app } = await appWithKey();
  const byAsin = await app.inject({
    method: "GET",
    url: `/v1/products/${BESTSELLER}`,
    headers: auth(),
  });
  const byUrl = await app.inject({
    method: "GET",
    url: `/v1/products/by-url?url=${encodeURIComponent(
      `https://www.amazon.com/dp/${BESTSELLER}`,
    )}`,
    headers: auth(),
  });
  assert.equal(byAsin.statusCode, 200);
  assert.equal(byUrl.statusCode, 200);
  const asinBody = byAsin.json() as OkBody;
  const urlBody = byUrl.json() as OkBody;
  assert.deepEqual(urlBody.data, asinBody.data);
  assert.ok(usefulProduct(urlBody.data));
  assert.equal(urlBody.meta.creditsCharged, 1);
});

test("by-url accepts /gp/product/ and asin= query", async () => {
  const { app } = await appWithKey();
  const cases = [
    `https://www.amazon.com/gp/product/${BOOK}`,
    `https://www.amazon.com/s?k=sapiens&asin=${BOOK}`,
  ];
  for (const url of cases) {
    const response = await app.inject({
      method: "GET",
      url: `/v1/products/by-url?url=${encodeURIComponent(url)}`,
      headers: auth(),
    });
    assert.equal(response.statusCode, 200, url);
    const body = response.json() as OkBody;
    assert.equal(body.data.asin, BOOK);
    assert.ok(body.data.title.includes("Sapiens"));
  }
});

test("SPEC 3: amzn.to short link resolves from the fixture map", async () => {
  const { app } = await appWithKey();
  const response = await app.inject({
    method: "GET",
    url: `/v1/products/by-url?url=${encodeURIComponent("https://amzn.to/Bests1")}`,
    headers: auth(),
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as OkBody;
  assert.equal(body.data.asin, BESTSELLER);
  assert.ok(usefulProduct(body.data));
  assert.equal(body.meta.creditsCharged, 1);
});

test("SPEC 5: .co.uk URL is 422 marketplace_unsupported and 0 credit", async () => {
  const { app, db } = await appWithKey(5);
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);

  const response = await app.inject({
    method: "GET",
    url: `/v1/products/by-url?url=${encodeURIComponent(
      "https://www.amazon.co.uk/dp/B0BESTSELL",
    )}`,
    headers: auth(),
  });
  assert.equal(response.statusCode, 422);
  const body = response.json() as ErrBody;
  assert.equal(body.error.code, "marketplace_unsupported");
  assert.equal(body.error.retryable, false);
  assert.equal(body.meta.creditsCharged, 0);
  assert.equal(getCredits(db, keyRow.id), 5);
  assert.equal("data" in body, false);
});

test("SPEC 6: garbage ASIN is 400 invalid_asin and 0 credit", async () => {
  const { app, db } = await appWithKey(5);
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);

  const cases = ["nope", "B0SHORT", "B0TOO-LONGX", "!!!!!!!!"];
  for (const asin of cases) {
    const response = await app.inject({
      method: "GET",
      url: `/v1/products/${asin}`,
      headers: auth(),
    });
    assert.equal(response.statusCode, 400, asin);
    const body = response.json() as ErrBody;
    assert.equal(body.error.code, "invalid_asin");
    assert.equal(body.meta.creditsCharged, 0);
  }
  assert.equal(getCredits(db, keyRow.id), 5);
});

test("unavailable fixture is 404 product_unavailable and 0 credit", async () => {
  const { app, db } = await appWithKey(5);
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);

  const response = await app.inject({
    method: "GET",
    url: `/v1/products/${UNAVAILABLE}`,
    headers: auth(),
  });
  assert.equal(response.statusCode, 404);
  const body = response.json() as ErrBody;
  assert.equal(body.error.code, "product_unavailable");
  assert.equal(body.meta.creditsCharged, 0);
  assert.equal(getCredits(db, keyRow.id), 5);
});

test("adult-adjacent fixture is 200, never 500", async () => {
  const { app } = await appWithKey();
  const response = await app.inject({
    method: "GET",
    url: `/v1/products/${ADULT}`,
    headers: auth(),
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as OkBody;
  assertProductShape(body.data);
  assert.ok(body.data.title.length > 0);
});

test("variation parent keeps a typed title and does not invent children", async () => {
  const { app } = await appWithKey();
  const response = await app.inject({
    method: "GET",
    url: `/v1/products/${VARIATION}`,
    headers: auth(),
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as OkBody;
  assert.ok(body.data.title.includes("Parent"));
  assert.equal("children" in body.data, false);
  assert.equal("variations" in body.data, false);
});

test("repeat ASIN is cached and still charges 1", async () => {
  const { app, db } = await appWithKey(10);
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);

  const first = await app.inject({
    method: "GET",
    url: `/v1/products/${BESTSELLER}`,
    headers: auth(),
  });
  assert.equal(first.statusCode, 200);
  const firstBody = first.json() as OkBody;
  assert.equal(firstBody.meta.cached, false);

  const started = performance.now();
  const second = await app.inject({
    method: "GET",
    url: `/v1/products/${BESTSELLER.toLowerCase()}`,
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
    url: `/v1/products/${BESTSELLER}`,
  });
  assert.equal(unauth.statusCode, 401);
  assert.equal((unauth.json() as ErrBody).error.code, "unauthorized");
  assert.equal((unauth.json() as ErrBody).meta.creditsCharged, 0);

  const broke = await app.inject({
    method: "GET",
    url: `/v1/products/${BESTSELLER}`,
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

test("forced adapter 503 is upstream_blocked and 0 credit", async () => {
  const blocked: ProductAdapter = {
    resolveShortCode() {
      return null;
    },
    async fetchProduct(): Promise<AdapterResult> {
      return { ok: false, code: "upstream_blocked" };
    },
    async fetchReviews() {
      return { ok: false, code: "upstream_blocked" as const };
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
    url: `/v1/products/${BESTSELLER}`,
    headers: auth(),
  });
  assert.equal(response.statusCode, 503);
  const body = response.json() as ErrBody;
  assert.equal(body.error.code, "upstream_blocked");
  assert.equal(body.error.retryable, true);
  assert.equal(body.meta.creditsCharged, 0);
  assert.equal(getCredits(db, keyRow.id), 4);
});

test("captcha HTML fixture is upstream_blocked without charging", async () => {
  const html = readFileSync(
    join(ROOT, "tests/fixtures/html/B0BLOCKED0.html"),
    "utf8",
  );
  assert.deepEqual(parseProductHtml(BLOCKED, html), {
    ok: false,
    code: "upstream_blocked",
  });
});

test("unknown catalog ASIN without HTML is 404 and 0 credit", async () => {
  const { app, db } = await appWithKey(3);
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);
  const response = await app.inject({
    method: "GET",
    url: "/v1/products/B00NOTHERE",
    headers: auth(),
  });
  assert.equal(response.statusCode, 404);
  assert.equal((response.json() as ErrBody).error.code, "product_unavailable");
  assert.equal(getCredits(db, keyRow.id), 3);
});

test("missing by-url query is 400 invalid_request and 0 credit", async () => {
  const { app, db } = await appWithKey(3);
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);
  const response = await app.inject({
    method: "GET",
    url: "/v1/products/by-url",
    headers: auth(),
  });
  assert.equal(response.statusCode, 400);
  assert.equal((response.json() as ErrBody).error.code, "invalid_request");
  assert.equal(getCredits(db, keyRow.id), 3);
});

test("HTTP routes call core only and never import adapters/amazon", () => {
  const httpDir = join(ROOT, "src/http");
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
  walk(httpDir);
  assert.ok(files.length > 0);
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    assert.doesNotMatch(src, /adapters\/amazon/, file);
  }
});

test("no live Amazon hosts are fetched from src or tests", () => {
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
    const src = readFileSync(file, "utf8");
    assert.doesNotMatch(src, /\bfetch\s*\(\s*['"`]https?:\/\/[^'"`]*amazon/i, file);
    assert.doesNotMatch(src, /https?:\/\/www\.amazon\.com\/gp\/product-api/i, file);
  }
});

test("OpenAPI freezes the product field list and every SPEC error code", () => {
  const spec = readFileSync(join(ROOT, "openapi/openapi.yaml"), "utf8");
  assert.match(spec, /\/v1\/products\/\{asin\}/);
  assert.match(spec, /\/v1\/products\/by-url/);
  assert.match(spec, /operationId: getProductByAsin/);
  assert.match(spec, /operationId: getProductByUrl/);
  for (const field of PRODUCT_FIELDS) {
    assert.match(spec, new RegExp(`^        ${field}:`, "m"), field);
  }
  for (const code of ERROR_CODES) {
    assert.match(spec, new RegExp(`- ${code}`));
  }
  assert.match(spec, /creditsCharged/);
  assert.match(spec, /marketplace_unsupported/);
  assert.match(spec, /invalid_asin/);
  assert.match(spec, /\/v1\/search/);
  assert.match(spec, /name: fields/);
  assert.doesNotMatch(spec, /\/offers/);
});

test("?fields= projects dotted product keys and still charges 1", async () => {
  const { app, db } = await appWithKey(5);
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);

  const response = await app.inject({
    method: "GET",
    url: `/v1/products/${BESTSELLER}?fields=title,price.amount,rating.average`,
    headers: auth(),
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    data: Record<string, unknown>;
    meta: { creditsCharged: number };
  };
  assert.deepEqual(Object.keys(body.data).sort(), ["price", "rating", "title"]);
  assert.equal(body.data.title, "Echo Dot (5th Gen, 2022 release) | Smart speaker with Alexa | Charcoal");
  assert.deepEqual(body.data.price, { amount: 49.99 });
  assert.deepEqual(body.data.rating, { average: 4.7 });
  assert.equal("asin" in body.data, false);
  assert.equal(body.meta.creditsCharged, 1);
  assert.equal(getCredits(db, keyRow.id), 4);
});

test("unknown fields path is 400 invalid_request and 0 credit", async () => {
  const { app, db } = await appWithKey(3);
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);

  const response = await app.inject({
    method: "GET",
    url: `/v1/products/${BESTSELLER}?fields=title,notAField`,
    headers: auth(),
  });
  assert.equal(response.statusCode, 400);
  const body = response.json() as ErrBody;
  assert.equal(body.error.code, "invalid_request");
  assert.match(body.error.message, /notAField/);
  assert.equal(body.meta.creditsCharged, 0);
  assert.equal(getCredits(db, keyRow.id), 3);
});

test("fields=attributes keeps the whole best-effort map", async () => {
  const { app } = await appWithKey();
  const response = await app.inject({
    method: "GET",
    url: `/v1/products/${BESTSELLER}?fields=attributes`,
    headers: auth(),
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as { data: Record<string, unknown> };
  assert.deepEqual(Object.keys(body.data), ["attributes"]);
  assert.deepEqual(body.data.attributes, { Color: "Charcoal", Generation: "5th" });
});

test("by-url accepts the same fields projection", async () => {
  const { app } = await appWithKey();
  const response = await app.inject({
    method: "GET",
    url: `/v1/products/by-url?url=${encodeURIComponent(
      `https://www.amazon.com/dp/${BESTSELLER}`,
    )}&fields=asin,brand`,
    headers: auth(),
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as { data: Record<string, unknown> };
  assert.deepEqual(body.data, { asin: BESTSELLER, brand: "Amazon" });
});

test("fixture HTTP payloads satisfy the frozen Product shape", async () => {
  const { app } = await appWithKey();
  const response = await app.inject({
    method: "GET",
    url: `/v1/products/${BESTSELLER}`,
    headers: auth(),
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as OkBody;
  assertProductShape(body.data);
  const extra = Object.keys(body.data).filter(
    (key) => !(PRODUCT_FIELDS as readonly string[]).includes(key),
  );
  assert.deepEqual(extra, []);
});
