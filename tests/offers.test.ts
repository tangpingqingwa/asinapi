import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createFixtureAdapter } from "../src/adapters/amazon/fixture.js";
import { buildApp } from "../src/app.js";
import { getCredits } from "../src/billing/credits.js";
import { createKey } from "../src/billing/keys.js";
import { getOffers, OFFERS_ROUTE } from "../src/core/offers.js";
import { openDatabase } from "../src/db.js";
import type { ErrorCode } from "../src/types.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = "ak_test_offers_fixture";
const BESTSELLER = "B0BESTSELL";

type ErrBody = {
  error: { code: ErrorCode; message: string; retryable: boolean };
  meta: { creditsCharged: number; requestId: string };
};

async function appWithKey(credits = 100) {
  const db = openDatabase(":memory:");
  createKey(db, { secret: KEY, credits });
  const app = await buildApp({
    db,
    adapter: createFixtureAdapter(),
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

test("getOffers is always not_implemented with 0 credits", () => {
  const result = getOffers({ asin: BESTSELLER, requestId: "req_offers" });
  assert.equal(result.error.code, "not_implemented");
  assert.equal(result.error.retryable, false);
  assert.equal(result.meta.creditsCharged, 0);
  assert.equal(result.meta.requestId, "req_offers");
  assert.equal(OFFERS_ROUTE, "/v1/products/{asin}/offers");
});

test("GET /v1/products/{asin}/offers is 501 not_implemented and charges 0", async () => {
  const { app, db } = await appWithKey(12);
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);
  assert.equal(getCredits(db, keyRow.id), 12);

  const response = await app.inject({
    method: "GET",
    url: `/v1/products/${BESTSELLER}/offers`,
    headers: auth(),
  });
  assert.equal(response.statusCode, 501);
  const body = response.json() as ErrBody;
  assert.equal(body.error.code, "not_implemented");
  assert.equal(body.error.retryable, false);
  assert.equal(body.meta.creditsCharged, 0);
  assert.match(body.meta.requestId, /^req_/);
  assert.equal(getCredits(db, keyRow.id), 12);

  const usage = db
    .prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM usage_events")
    .get();
  assert.equal(usage?.n, 0);
});

test("offers 501 does not depend on ASIN validity or remaining credits", async () => {
  const { app, db } = await appWithKey(0);
  const keyRow = db.prepare<[], { id: string }>("SELECT id FROM keys").get();
  assert.ok(keyRow);

  for (const asin of [BESTSELLER, "not-an-asin", "b0bestsell"]) {
    const response = await app.inject({
      method: "GET",
      url: `/v1/products/${asin}/offers`,
      headers: auth(),
    });
    assert.equal(response.statusCode, 501, asin);
    const body = response.json() as ErrBody;
    assert.equal(body.error.code, "not_implemented");
    assert.equal(body.meta.creditsCharged, 0);
  }
  assert.equal(getCredits(db, keyRow.id), 0);
});

test("unauthenticated offers request is 401 with 0 credits", async () => {
  const { app } = await appWithKey(3);
  const response = await app.inject({
    method: "GET",
    url: `/v1/products/${BESTSELLER}/offers`,
  });
  assert.equal(response.statusCode, 401);
  const body = response.json() as ErrBody;
  assert.equal(body.error.code, "unauthorized");
  assert.equal(body.meta.creditsCharged, 0);
});

test("OpenAPI documents offers 501 and 0 credits; homepage does not advertise it", () => {
  const spec = readFileSync(join(ROOT, "openapi/openapi.yaml"), "utf8");
  assert.match(spec, /\/v1\/products\/\{asin\}\/offers/);
  assert.match(spec, /operationId: getProductOffers/);
  assert.match(spec, /not_implemented/);
  assert.match(spec, /charges 0 credits/);
  assert.match(spec, /Do not advertise on the homepage/);
  assert.match(spec, /"501"/);

  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  assert.doesNotMatch(readme, /offers/i);
  assert.doesNotMatch(readme, /buy[- ]?box/i);
});

test("offers handler never fetches Amazon and MCP does not ship offers", () => {
  const offers = readFileSync(join(ROOT, "src/core/offers.ts"), "utf8");
  assert.doesNotMatch(offers, /\bfetch\s*\(/);
  assert.doesNotMatch(offers, /adapters\/amazon/);
  assert.doesNotMatch(offers, /https?:\/\/www\.amazon\.com/);

  const tools = readFileSync(join(ROOT, "src/mcp/tools.ts"), "utf8");
  assert.doesNotMatch(tools, /GET_OFFERS|list_offers|"offers"/);

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
    assert.doesNotMatch(
      src,
      /\bfetch\s*\(\s*['"`]https?:\/\/[^'"`]*amazon/i,
      file,
    );
    assert.doesNotMatch(src, /https?:\/\/www\.amazon\.com\/gp\/product-api/i, file);
  }
});
