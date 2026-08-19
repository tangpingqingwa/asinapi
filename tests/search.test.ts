import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createFixtureAdapter,
  parseSearchHtml,
} from "../src/adapters/amazon/fixture.js";
import type {
  ProductAdapter,
  SearchAdapterResult,
} from "../src/adapters/types.js";
import { buildApp } from "../src/app.js";
import { getCredits } from "../src/billing/credits.js";
import { createKey } from "../src/billing/keys.js";
import { parseFields } from "../src/core/fields.js";
import { SEARCH_PAGE_FIELD_SCHEMA } from "../src/core/field-schema.js";
import {
  MAX_SEARCH_PAGE,
  parseSearchPage,
  parseSearchQuery,
  searchCreditCost,
} from "../src/core/search.js";
import { openDatabase } from "../src/db.js";
import {
  SEARCH_PAGE_FIELDS,
  SEARCH_RESULT_FIELDS,
  type ErrorCode,
  type SearchPage,
  type SearchResult,
} from "../src/types.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = "ak_test_search_fixture";

type OkBody = {
  data: SearchPage;
  meta: {
    cached: boolean;
    creditsCharged: number;
    requestId: string;
    upstreamMs: number;
  };
};

type ProjectedOk = {
  data: Record<string, unknown>;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertSearchResultShape(result: SearchResult): void {
  for (const field of SEARCH_RESULT_FIELDS) {
    assert.ok(field in result, `missing ${field}`);
  }
  assert.match(result.asin, /^[A-Z0-9]{10}$/);
  assert.ok(result.title.length > 0);
  assert.equal(result.price.currency, "USD");
  assert.equal(typeof result.price.unavailable, "boolean");
  assert.ok(result.url.startsWith("https://"));
  assert.ok(result.image === null || result.image.startsWith("https://"));
}

function assertSearchPageShape(page: SearchPage): void {
  for (const field of SEARCH_PAGE_FIELDS) {
    assert.ok(field in page, `missing ${field}`);
  }
  assert.equal(typeof page.q, "string");
  assert.equal(typeof page.page, "number");
  assert.ok(page.page >= 1 && page.page <= MAX_SEARCH_PAGE);
  assert.equal(typeof page.hasMore, "boolean");
  assert.ok(Array.isArray(page.results));
  for (const result of page.results) {
    assertSearchResultShape(result);
  }
}

test("parseSearchQuery trims and rejects empty q", () => {
  assert.equal(parseSearchQuery("echo dot"), "echo dot");
  assert.equal(parseSearchQuery("  echo   dot  "), "echo dot");
  assert.equal(parseSearchQuery(undefined), null);
  assert.equal(parseSearchQuery(""), null);
  assert.equal(parseSearchQuery("   "), null);
});

test("parseSearchPage is 1-based and caps at 5", () => {
  assert.equal(parseSearchPage(undefined), 1);
  assert.equal(parseSearchPage(""), 1);
  assert.equal(parseSearchPage("1"), 1);
  assert.equal(parseSearchPage(5), 5);
  assert.equal(parseSearchPage("5"), 5);
  assert.equal(parseSearchPage("6"), null);
  assert.equal(parseSearchPage(6), null);
  assert.equal(parseSearchPage("0"), null);
  assert.equal(parseSearchPage("-1"), null);
  assert.equal(parseSearchPage("1.5"), null);
  assert.equal(parseSearchPage("page"), null);
});

test("searchCreditCost is 1 per result, including empty pages", () => {
  assert.equal(searchCreditCost(0), 0);
  assert.equal(searchCreditCost(1), 1);
  assert.equal(searchCreditCost(2), 2);
});

test("parseFields accepts dotted product and search paths", () => {
  const product = parseFields("title,price.amount");
  assert.equal(product.ok, true);
  if (product.ok) {
    assert.deepEqual(product.paths, ["title", "price.amount"]);
  }
  const search = parseFields("results.asin,results.title", SEARCH_PAGE_FIELD_SCHEMA);
  assert.equal(search.ok, true);
  if (search.ok) {
    assert.deepEqual(search.paths, ["results.asin", "results.title"]);
  }
  const unknown = parseFields("results.notAField", SEARCH_PAGE_FIELD_SCHEMA);
  assert.equal(unknown.ok, false);
  const empty = parseFields("");
  assert.equal(empty.ok, true);
  if (empty.ok) {
    assert.equal(empty.paths, null);
  }
});

test("representative search HTML fixtures parse recorded results only", () => {
  const searchDir = join(ROOT, "tests/fixtures/html/search");
  const page1 = parseSearchHtml(
    "echo dot",
    1,
    readFileSync(join(searchDir, "echo-dot.p1.html"), "utf8"),
  );
  assert.equal(page1.ok, true);
  if (page1.ok) {
    assert.equal(page1.page.hasMore, true);
    assert.deepEqual(
      page1.page.results.map((row) => row.asin),
      ["B0BESTSELL", "B0VARIATN1"],
    );
    assert.equal(page1.page.results[0]?.price.amount, 49.99);
    assert.equal(page1.page.results[0]?.rating.average, 4.7);
    assert.ok(page1.page.results[0]?.image?.startsWith("https://"));
  }

  const page2 = parseSearchHtml(
    "echo dot",
    2,
    readFileSync(join(searchDir, "echo-dot.p2.html"), "utf8"),
  );
  assert.equal(page2.ok, true);
  if (page2.ok) {
    assert.equal(page2.page.hasMore, false);
    assert.deepEqual(
      page2.page.results.map((row) => row.asin),
      ["B0BOOK0001"],
    );
  }

  const blocked = parseSearchHtml(
    "blocked",
    1,
    readFileSync(join(searchDir, "blocked.p1.html"), "utf8"),
  );
  assert.deepEqual(blocked, { ok: false, code: "upstream_blocked" });

  const empty = parseSearchHtml(
    "empty query",
    1,
    readFileSync(join(searchDir, "empty-query.p1.html"), "utf8"),
  );
  assert.equal(empty.ok, true);
  if (empty.ok) {
    assert.deepEqual(empty.page.results, []);
    assert.equal(empty.page.hasMore, false);
  }
});

test("GET /v1/search returns recorded hits and charges 1 per result", async () => {
  const { app, db } = await appWithKey(10);
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);

  const response = await app.inject({
    method: "GET",
    url: "/v1/search?q=echo%20dot",
    headers: auth(),
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as OkBody;
  assertSearchPageShape(body.data);
  assert.equal(body.data.q, "echo dot");
  assert.equal(body.data.page, 1);
  assert.equal(body.data.hasMore, true);
  assert.equal(body.data.results.length, 2);
  assert.equal(body.data.results[0]?.asin, "B0BESTSELL");
  assert.equal(body.data.results[0]?.title.includes("Echo Dot"), true);
  assert.equal(body.meta.cached, false);
  assert.equal(body.meta.creditsCharged, 2);
  assert.match(body.meta.requestId, /^req_/);
  assert.equal(getCredits(db, keyRow.id), 8);
});

test("search page 2 is a different recorded page and still bills per result", async () => {
  const { app, db } = await appWithKey(5);
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);

  const response = await app.inject({
    method: "GET",
    url: "/v1/search?q=echo%20dot&page=2",
    headers: auth(),
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as OkBody;
  assert.equal(body.data.page, 2);
  assert.equal(body.data.hasMore, false);
  assert.equal(body.data.results.length, 1);
  assert.equal(body.data.results[0]?.asin, "B0BOOK0001");
  assert.equal(body.meta.creditsCharged, 1);
  assert.equal(getCredits(db, keyRow.id), 4);
});

test("page above 5 is 400 invalid_request and 0 credit", async () => {
  const { app, db } = await appWithKey(4);
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);

  for (const page of ["6", "99", "0", "-1", "1.5"]) {
    const response = await app.inject({
      method: "GET",
      url: `/v1/search?q=echo%20dot&page=${page}`,
      headers: auth(),
    });
    assert.equal(response.statusCode, 400, page);
    const body = response.json() as ErrBody;
    assert.equal(body.error.code, "invalid_request");
    assert.equal(body.meta.creditsCharged, 0);
  }
  assert.equal(getCredits(db, keyRow.id), 4);
});

test("missing q is 400 and 0 credit", async () => {
  const { app, db } = await appWithKey(3);
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);

  const response = await app.inject({
    method: "GET",
    url: "/v1/search",
    headers: auth(),
  });
  assert.equal(response.statusCode, 400);
  const body = response.json() as ErrBody;
  assert.equal(body.error.code, "invalid_request");
  assert.equal(body.meta.creditsCharged, 0);
  assert.equal(getCredits(db, keyRow.id), 3);
});

test("empty recorded search page is 200 with [] and charges 0", async () => {
  const { app, db } = await appWithKey(5);
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);

  const response = await app.inject({
    method: "GET",
    url: "/v1/search?q=empty%20query",
    headers: auth(),
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as OkBody;
  assert.deepEqual(body.data.results, []);
  assert.equal(body.data.hasMore, false);
  assert.equal(body.meta.creditsCharged, 0);
  assert.equal(getCredits(db, keyRow.id), 5);
});

test("unknown query is an empty recorded miss, never invented, 0 credit", async () => {
  const { app, db } = await appWithKey(5);
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);

  const response = await app.inject({
    method: "GET",
    url: "/v1/search?q=no-such-fixture-query",
    headers: auth(),
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as OkBody;
  assert.deepEqual(body.data.results, []);
  assert.equal(body.meta.creditsCharged, 0);
  assert.equal(getCredits(db, keyRow.id), 5);
});

test("repeat search is cached and still charges 1 per result", async () => {
  const { app, db } = await appWithKey(10);
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);

  const first = await app.inject({
    method: "GET",
    url: "/v1/search?q=echo%20dot",
    headers: auth(),
  });
  assert.equal(first.statusCode, 200);
  const firstBody = first.json() as OkBody;
  assert.equal(firstBody.meta.cached, false);
  assert.equal(firstBody.meta.creditsCharged, 2);

  const second = await app.inject({
    method: "GET",
    url: "/v1/search?q=ECHO%20DOT",
    headers: auth(),
  });
  assert.equal(second.statusCode, 200);
  const secondBody = second.json() as OkBody;
  assert.equal(secondBody.meta.cached, true);
  assert.equal(secondBody.meta.creditsCharged, 2);
  assert.equal(secondBody.meta.upstreamMs, 0);
  assert.deepEqual(secondBody.data.results, firstBody.data.results);
  assert.equal(getCredits(db, keyRow.id), 6);
});

test("search ?fields= projects result keys and still bills per result", async () => {
  const { app, db } = await appWithKey(6);
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);

  const response = await app.inject({
    method: "GET",
    url: "/v1/search?q=echo%20dot&fields=results.asin,results.title,page",
    headers: auth(),
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as ProjectedOk;
  assert.deepEqual(Object.keys(body.data).sort(), ["page", "results"]);
  assert.equal(body.data.page, 1);
  const results = body.data.results as Array<Record<string, unknown>>;
  assert.equal(results.length, 2);
  assert.deepEqual(Object.keys(results[0] ?? {}).sort(), ["asin", "title"]);
  assert.equal(results[0]?.asin, "B0BESTSELL");
  assert.equal("q" in body.data, false);
  assert.equal(body.meta.creditsCharged, 2);
  assert.equal(getCredits(db, keyRow.id), 4);
});

test("unknown search fields path is 400 and 0 credit", async () => {
  const { app, db } = await appWithKey(3);
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);

  const response = await app.inject({
    method: "GET",
    url: "/v1/search?q=echo%20dot&fields=results.secret",
    headers: auth(),
  });
  assert.equal(response.statusCode, 400);
  const body = response.json() as ErrBody;
  assert.equal(body.error.code, "invalid_request");
  assert.equal(body.meta.creditsCharged, 0);
  assert.equal(getCredits(db, keyRow.id), 3);
});

test("too few credits for the result count is 402 before charging", async () => {
  const { app, db } = await appWithKey(1);
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);

  const response = await app.inject({
    method: "GET",
    url: "/v1/search?q=echo%20dot",
    headers: auth(),
  });
  assert.equal(response.statusCode, 402);
  const body = response.json() as ErrBody;
  assert.equal(body.error.code, "payment_required");
  assert.equal(body.meta.creditsCharged, 0);
  assert.equal(getCredits(db, keyRow.id), 1);
});

test("zero credits is 402 before adapter work", async () => {
  const { app, db } = await appWithKey(0);
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);

  const response = await app.inject({
    method: "GET",
    url: "/v1/search?q=echo%20dot",
    headers: auth(),
  });
  assert.equal(response.statusCode, 402);
  assert.equal((response.json() as ErrBody).error.code, "payment_required");
  assert.equal(getCredits(db, keyRow.id), 0);
  const cached = db
    .prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM cache_entries")
    .get();
  assert.equal(cached?.n, 0);
});

test("forced adapter 503 on search is upstream_blocked and 0 credit", async () => {
  const blocked: ProductAdapter = {
    resolveShortCode() {
      return null;
    },
    async fetchProduct() {
      return { ok: false, code: "upstream_blocked" };
    },
    async fetchReviews() {
      return { ok: false, code: "upstream_blocked" as const };
    },
    async fetchSearch(): Promise<SearchAdapterResult> {
      return { ok: false, code: "upstream_blocked" };
    },
  };
  const { app, db } = await appWithKey(4, blocked);
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);

  const response = await app.inject({
    method: "GET",
    url: "/v1/search?q=echo%20dot",
    headers: auth(),
  });
  assert.equal(response.statusCode, 503);
  const body = response.json() as ErrBody;
  assert.equal(body.error.code, "upstream_blocked");
  assert.equal(body.error.retryable, true);
  assert.equal(body.meta.creditsCharged, 0);
  assert.equal(getCredits(db, keyRow.id), 4);
});

test("captcha search fixture is upstream_blocked without charging", async () => {
  const { app, db } = await appWithKey(4);
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);

  const response = await app.inject({
    method: "GET",
    url: "/v1/search?q=blocked",
    headers: auth(),
  });
  assert.equal(response.statusCode, 503);
  const body = response.json() as ErrBody;
  assert.equal(body.error.code, "upstream_blocked");
  assert.equal(body.meta.creditsCharged, 0);
  assert.equal(getCredits(db, keyRow.id), 4);
});

test("HTTP search route calls core only and never imports adapters/amazon", () => {
  const src = readFileSync(join(ROOT, "src/http/routes/search.ts"), "utf8");
  assert.match(src, /searchProducts/);
  assert.doesNotMatch(src, /adapters\/amazon/);
});

test("no live Amazon search hosts are fetched from src or tests", () => {
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

test("OpenAPI freezes search result fields and page cap", () => {
  const spec = readFileSync(join(ROOT, "openapi/openapi.yaml"), "utf8");
  assert.match(spec, /\/v1\/search/);
  assert.match(spec, /operationId: searchProducts/);
  assert.match(spec, /maximum: 5/);
  assert.match(spec, /1 credit per result/);
  for (const field of SEARCH_PAGE_FIELDS) {
    assert.match(spec, new RegExp(`^        ${field}:`, "m"), field);
  }
  for (const field of SEARCH_RESULT_FIELDS) {
    assert.match(spec, new RegExp(`^        ${field}:`, "m"), field);
  }
  assert.match(spec, /name: fields/);
  assert.match(spec, /\/v1\/products\/\{asin\}\/offers/);
  assert.match(spec, /not_implemented/);
});

test("fixture search payloads satisfy the frozen SearchPage shape", async () => {
  const { app } = await appWithKey();
  const response = await app.inject({
    method: "GET",
    url: "/v1/search?q=echo%20dot",
    headers: auth(),
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as OkBody;
  assertSearchPageShape(body.data);
  const extraPage = Object.keys(body.data).filter(
    (key) => !(SEARCH_PAGE_FIELDS as readonly string[]).includes(key),
  );
  assert.deepEqual(extraPage, []);
  const extraResult = Object.keys(body.data.results[0] ?? {}).filter(
    (key) => !(SEARCH_RESULT_FIELDS as readonly string[]).includes(key),
  );
  assert.deepEqual(extraResult, []);
  assert.ok(isRecord(body.data.results[0]));
});
