import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createFixtureAdapter } from "../src/adapters/amazon/fixture.js";
import type { ProductAdapter } from "../src/adapters/types.js";
import { buildApp } from "../src/app.js";
import { getCredits } from "../src/billing/credits.js";
import { createKey } from "../src/billing/keys.js";
import { openDatabase } from "../src/db.js";
import { MCP_PATH, MCP_PROTOCOL_VERSION } from "../src/mcp/server.js";
import {
  GET_PRODUCT_TOOL,
  LIST_REVIEWS_TOOL,
  SEARCH_AMAZON_TOOL,
} from "../src/mcp/tools.js";
import type { ErrorCode, Product, ReviewPage, SearchPage } from "../src/types.js";

const KEY = "ak_test_mcp_fixture";
const BESTSELLER = "B0BESTSELL";
const UNAVAILABLE = "B0UNAVAIL0";
const BLOCKED = "B0BLOCKED0";
const EMPTY = "B0NOREVIEW";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

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

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent: OkBody<unknown> | ErrBody;
  isError: boolean;
};

type JsonRpcOk = {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
};

async function appWithKey(credits = 100, adapter?: ProductAdapter) {
  const db = openDatabase(":memory:");
  const key = createKey(db, { secret: KEY, credits });
  const app = await buildApp({
    db,
    adapter: adapter ?? createFixtureAdapter(),
  });
  after(async () => {
    await app.close();
    db.close();
  });
  return { app, db, key };
}

function auth() {
  return { authorization: `Bearer ${KEY}` };
}

async function rpc(
  app: Awaited<ReturnType<typeof buildApp>>,
  method: string,
  params?: unknown,
  headers: Record<string, string> = auth(),
) {
  return app.inject({
    method: "POST",
    url: MCP_PATH,
    headers,
    payload: { jsonrpc: "2.0", id: 1, method, params },
  });
}

async function callTool(
  app: Awaited<ReturnType<typeof buildApp>>,
  name: string,
  args: Record<string, unknown> = {},
) {
  const response = await rpc(app, "tools/call", { name, arguments: args });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as JsonRpcOk;
  const result = body.result as ToolResult;
  assert.ok(result);
  assert.equal(typeof result.isError, "boolean");
  return result;
}

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, name.name);
    if (name.isDirectory()) {
      out.push(...walkTs(path));
    } else if (name.name.endsWith(".ts")) {
      out.push(path);
    }
  }
  return out;
}

test("GET /llms.txt is public and matches the checked-in file", async () => {
  const { app } = await appWithKey();
  const response = await app.inject({ method: "GET", url: "/llms.txt" });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"] ?? "", /text\/plain/);
  const onDisk = readFileSync(join(ROOT, "llms.txt"), "utf8");
  assert.equal(response.body, onDisk);
  assert.match(onDisk, /get_product/);
  assert.match(onDisk, /list_reviews/);
  assert.match(onDisk, /When not to call/i);
  assert.match(onDisk, /US only|US Amazon|US \.com/i);
  assert.match(onDisk, /not for checkout/i);
  assert.match(onDisk, /6h stale|6 hours stale/i);
  assert.match(onDisk, /Keepa/i);
  assert.match(onDisk, /search_amazon/);
  assert.match(onDisk, /1 credit per result/);
});

test("GET /.well-known/mcp/server-card.json lists shipped tools only", async () => {
  const { app } = await appWithKey();
  const response = await app.inject({
    method: "GET",
    url: "/.well-known/mcp/server-card.json",
  });
  assert.equal(response.statusCode, 200);
  const card = response.json() as { tools: string[]; transport: string };
  assert.equal(card.transport, "streamable-http");
  assert.deepEqual(card.tools, [
    GET_PRODUCT_TOOL,
    LIST_REVIEWS_TOOL,
    SEARCH_AMAZON_TOOL,
  ]);
  const names: string[] = card.tools.slice();
  assert.equal(names.includes("search_amazon"), true);
  assert.ok(!names.some((name) => name.includes("offer")));
});

test("POST /mcp without bearer is 401 with 0 credits", async () => {
  const { app } = await appWithKey();
  const response = await rpc(app, "initialize", undefined, {});
  assert.equal(response.statusCode, 401);
  const body = response.json() as ErrBody;
  assert.equal(body.error.code, "unauthorized");
  assert.equal(body.meta.creditsCharged, 0);
});

test("initialize and tools/list describe get_product, list_reviews, and search_amazon", async () => {
  const { app } = await appWithKey();

  const init = await rpc(app, "initialize");
  assert.equal(init.statusCode, 200);
  const initBody = init.json() as JsonRpcOk;
  const initResult = initBody.result as {
    protocolVersion: string;
    capabilities: { tools: unknown };
    serverInfo: { name: string };
    instructions: string;
  };
  assert.equal(initResult.protocolVersion, MCP_PROTOCOL_VERSION);
  assert.equal(initResult.serverInfo.name, "asinapi");
  assert.ok(initResult.capabilities.tools);
  assert.match(initResult.instructions, /not for checkout/i);
  assert.match(initResult.instructions, /6 hours stale/i);
  assert.match(initResult.instructions, /Keepa/i);

  const listed = await rpc(app, "tools/list");
  assert.equal(listed.statusCode, 200);
  const tools = (
    (listed.json() as JsonRpcOk).result as {
      tools: Array<{ name: string }>;
    }
  ).tools.map((tool) => tool.name);
  assert.deepEqual(tools, [
    GET_PRODUCT_TOOL,
    LIST_REVIEWS_TOOL,
    SEARCH_AMAZON_TOOL,
  ]);
  assert.ok(!tools.some((name) => name.includes("offer")));
});

test("MCP get_product returns the same payload as REST and charges 1", async () => {
  const { app, db, key } = await appWithKey(10);

  const rest = await app.inject({
    method: "GET",
    url: `/v1/products/${BESTSELLER}`,
    headers: auth(),
  });
  assert.equal(rest.statusCode, 200);
  const restBody = rest.json() as OkBody<Product>;
  assert.ok(restBody.data.title.includes("Echo Dot"));
  assert.equal(restBody.meta.creditsCharged, 1);
  assert.equal(getCredits(db, key.id), 9);

  const mcp = await callTool(app, GET_PRODUCT_TOOL, { asin: BESTSELLER });
  assert.equal(mcp.isError, false);
  const mcpBody = mcp.structuredContent as OkBody<Product>;
  assert.deepEqual(mcpBody.data, restBody.data);
  assert.equal(mcpBody.meta.creditsCharged, 1);
  assert.equal(mcpBody.meta.cached, true);
  assert.equal(mcpBody.meta.upstreamMs, 0);
  assert.match(mcpBody.meta.requestId, /^req_/);
  assert.equal(getCredits(db, key.id), 8);

  const parsedText = JSON.parse(mcp.content[0]?.text ?? "null") as OkBody<Product>;
  assert.deepEqual(parsedText.data, restBody.data);
});

test("MCP get_product url argument matches REST by-url and still charges 1", async () => {
  const { app, db, key } = await appWithKey(4);
  const url = `https://www.amazon.com/dp/${BESTSELLER}`;

  const mcp = await callTool(app, GET_PRODUCT_TOOL, { url });
  assert.equal(mcp.isError, false);
  const mcpBody = mcp.structuredContent as OkBody<Product>;
  assert.equal(mcpBody.data.asin, BESTSELLER);
  assert.ok(mcpBody.data.title.includes("Echo Dot"));
  assert.equal(mcpBody.meta.creditsCharged, 1);

  const rest = await app.inject({
    method: "GET",
    url: `/v1/products/by-url?url=${encodeURIComponent(url)}`,
    headers: auth(),
  });
  const restBody = rest.json() as OkBody<Product>;
  assert.deepEqual(restBody.data, mcpBody.data);
  assert.equal(getCredits(db, key.id), 2);
});

test("MCP get_product accepts amzn.to from the fixture map", async () => {
  const { app } = await appWithKey();
  const mcp = await callTool(app, GET_PRODUCT_TOOL, {
    url: "https://amzn.to/Bests1",
  });
  assert.equal(mcp.isError, false);
  const body = mcp.structuredContent as OkBody<Product>;
  assert.equal(body.data.asin, BESTSELLER);
  assert.equal(body.meta.creditsCharged, 1);
});

test("MCP get_product errors match REST: invalid_asin, unavailable, marketplace, 402", async () => {
  const { app, db, key } = await appWithKey(3);

  const garbage = await callTool(app, GET_PRODUCT_TOOL, { asin: "nope" });
  assert.equal(garbage.isError, true);
  const garbageBody = garbage.structuredContent as ErrBody;
  assert.equal(garbageBody.error.code, "invalid_asin");
  assert.equal(garbageBody.meta.creditsCharged, 0);

  const gone = await callTool(app, GET_PRODUCT_TOOL, { asin: UNAVAILABLE });
  assert.equal((gone.structuredContent as ErrBody).error.code, "product_unavailable");
  assert.equal((gone.structuredContent as ErrBody).meta.creditsCharged, 0);

  const uk = await callTool(app, GET_PRODUCT_TOOL, {
    url: "https://www.amazon.co.uk/dp/B0BESTSELL",
  });
  assert.equal(
    (uk.structuredContent as ErrBody).error.code,
    "marketplace_unsupported",
  );
  assert.equal((uk.structuredContent as ErrBody).meta.creditsCharged, 0);

  const missing = await callTool(app, GET_PRODUCT_TOOL, {});
  assert.equal((missing.structuredContent as ErrBody).error.code, "invalid_request");
  assert.equal((missing.structuredContent as ErrBody).meta.creditsCharged, 0);

  const empty = await appWithKey(0);
  const unpaid = await callTool(empty.app, GET_PRODUCT_TOOL, {
    asin: BESTSELLER,
  });
  assert.equal((unpaid.structuredContent as ErrBody).error.code, "payment_required");
  assert.equal((unpaid.structuredContent as ErrBody).meta.creditsCharged, 0);
  assert.equal(getCredits(db, key.id), 3);
});

test("MCP list_reviews returns the same page as REST and never fakes", async () => {
  const { app, db, key } = await appWithKey(10);

  const rest = await app.inject({
    method: "GET",
    url: `/v1/products/${BESTSELLER}/reviews`,
    headers: auth(),
  });
  assert.equal(rest.statusCode, 200);
  const restBody = rest.json() as OkBody<ReviewPage>;
  assert.ok(restBody.data.reviews.length >= 1);
  assert.equal(restBody.meta.creditsCharged, 1);
  assert.equal(getCredits(db, key.id), 9);

  const mcp = await callTool(app, LIST_REVIEWS_TOOL, { asin: BESTSELLER });
  assert.equal(mcp.isError, false);
  const mcpBody = mcp.structuredContent as OkBody<ReviewPage>;
  assert.deepEqual(mcpBody.data, restBody.data);
  assert.equal(mcpBody.meta.creditsCharged, 1);
  assert.equal(mcpBody.meta.cached, true);
  assert.equal(getCredits(db, key.id), 8);
});

test("MCP list_reviews empty page is 200-shaped empty list, not invented", async () => {
  const { app } = await appWithKey();
  const empty = await callTool(app, LIST_REVIEWS_TOOL, { asin: EMPTY });
  assert.equal(empty.isError, false);
  const emptyBody = empty.structuredContent as OkBody<ReviewPage>;
  assert.deepEqual(emptyBody.data, { page: 1, hasMore: false, reviews: [] });
  assert.equal(emptyBody.meta.creditsCharged, 1);

  const beyond = await callTool(app, LIST_REVIEWS_TOOL, {
    asin: BESTSELLER,
    page: 99,
  });
  assert.equal(beyond.isError, false);
  const beyondBody = beyond.structuredContent as OkBody<ReviewPage>;
  assert.deepEqual(beyondBody.data, { page: 99, hasMore: false, reviews: [] });
});

test("MCP list_reviews sort=recent does not leak helpful ids", async () => {
  const { app } = await appWithKey();
  const helpful = await callTool(app, LIST_REVIEWS_TOOL, {
    asin: BESTSELLER,
    sort: "helpful",
  });
  const recent = await callTool(app, LIST_REVIEWS_TOOL, {
    asin: BESTSELLER,
    sort: "recent",
  });
  assert.equal(helpful.isError, false);
  assert.equal(recent.isError, false);
  const helpfulIds = (helpful.structuredContent as OkBody<ReviewPage>).data.reviews.map(
    (review) => review.id,
  );
  const recentIds = (recent.structuredContent as OkBody<ReviewPage>).data.reviews.map(
    (review) => review.id,
  );
  assert.deepEqual(helpfulIds, ["R10BESTHELP", "R11BESTHELP", "R12BESTHELP"]);
  assert.deepEqual(recentIds, ["R20BESTREC", "R21BESTREC"]);
});

test("MCP list_reviews errors match REST and charge 0", async () => {
  const { app, db, key } = await appWithKey(4);

  const badPage = await callTool(app, LIST_REVIEWS_TOOL, {
    asin: BESTSELLER,
    page: 0,
  });
  assert.equal((badPage.structuredContent as ErrBody).error.code, "invalid_request");
  assert.equal((badPage.structuredContent as ErrBody).meta.creditsCharged, 0);

  const badSort = await callTool(app, LIST_REVIEWS_TOOL, {
    asin: BESTSELLER,
    sort: "top",
  });
  assert.equal((badSort.structuredContent as ErrBody).error.code, "invalid_request");

  const garbage = await callTool(app, LIST_REVIEWS_TOOL, { asin: "nope" });
  assert.equal((garbage.structuredContent as ErrBody).error.code, "invalid_asin");

  const gone = await callTool(app, LIST_REVIEWS_TOOL, { asin: UNAVAILABLE });
  assert.equal((gone.structuredContent as ErrBody).error.code, "product_unavailable");

  const blocked = await callTool(app, LIST_REVIEWS_TOOL, { asin: BLOCKED });
  assert.equal((blocked.structuredContent as ErrBody).error.code, "upstream_blocked");
  assert.equal((blocked.structuredContent as ErrBody).meta.creditsCharged, 0);
  assert.equal(getCredits(db, key.id), 4);
});

test("MCP search_amazon matches REST and charges 1 per result", async () => {
  const { app, db, key } = await appWithKey(10);

  const rest = await app.inject({
    method: "GET",
    url: "/v1/search?q=echo%20dot",
    headers: auth(),
  });
  assert.equal(rest.statusCode, 200);
  const restBody = rest.json() as OkBody<SearchPage>;
  assert.equal(restBody.data.results.length, 2);
  assert.equal(restBody.meta.creditsCharged, 2);
  assert.equal(getCredits(db, key.id), 8);

  const mcp = await callTool(app, SEARCH_AMAZON_TOOL, { q: "echo dot" });
  assert.equal(mcp.isError, false);
  const mcpBody = mcp.structuredContent as OkBody<SearchPage>;
  assert.deepEqual(mcpBody.data, restBody.data);
  assert.equal(mcpBody.meta.creditsCharged, 2);
  assert.equal(mcpBody.meta.cached, true);
  assert.equal(getCredits(db, key.id), 6);
});

test("unknown MCP tool and get_offers are invalid_request with 0 credits", async () => {
  const { app, db, key } = await appWithKey(5);
  for (const name of ["get_offers", "not_a_tool"]) {
    const result = await callTool(app, name, { asin: BESTSELLER });
    assert.equal(result.isError, true, name);
    const body = result.structuredContent as ErrBody;
    assert.equal(body.error.code, "invalid_request");
    assert.equal(body.meta.creditsCharged, 0);
  }
  assert.equal(getCredits(db, key.id), 5);
});

test("HTTP and MCP call core only and never import adapters/amazon", () => {
  const files = [
    ...walkTs(join(ROOT, "src/http")),
    ...walkTs(join(ROOT, "src/mcp")),
  ];
  assert.ok(files.length > 0);
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    assert.doesNotMatch(src, /adapters\/amazon/, file);
  }
  const tools = readFileSync(join(ROOT, "src/mcp/tools.ts"), "utf8");
  assert.match(tools, /getProduct/);
  assert.match(tools, /getReviews/);
  assert.match(tools, /searchProducts/);
  assert.match(tools, /search_amazon/);
});

test("no live Amazon hosts are fetched from MCP sources", () => {
  for (const file of walkTs(join(ROOT, "src/mcp"))) {
    const src = readFileSync(file, "utf8");
    assert.doesNotMatch(src, /\bfetch\s*\(/, file);
    assert.doesNotMatch(src, /https?:\/\/www\.amazon\.com\/gp\/product-api/i, file);
  }
});
