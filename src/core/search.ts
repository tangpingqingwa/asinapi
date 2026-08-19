import { randomUUID } from "node:crypto";
import type { ProductAdapter } from "../adapters/types.js";
import {
  chargeCredits,
  getCredits,
  SEARCH_CREDIT_PER_RESULT,
} from "../billing/credits.js";
import type { Key } from "../billing/keys.js";
import {
  getCacheEntry,
  searchCacheKey,
  setSearchCache,
} from "../cache/store.js";
import type { AsinApiDb } from "../db.js";
import type {
  Err,
  ErrorCode,
  Ok,
  SearchPage,
  SearchResult,
} from "../types.js";
import { SEARCH_PAGE_FIELD_SCHEMA } from "./field-schema.js";
import { parseFields, projectFields } from "./fields.js";
import { isRetryableCode } from "./product.js";

export const SEARCH_ROUTE = "/v1/search" as const;
export const MAX_SEARCH_PAGE = 5;

export type SearchOutcome = Ok<SearchPage | Record<string, unknown>> | Err;

export type SearchInput = {
  db: AsinApiDb;
  adapter: ProductAdapter;
  key: Key;
  q?: string;
  page?: string | number;
  fields?: string;
  requestId?: string;
};

const ERROR_MESSAGE: Record<ErrorCode, string> = {
  invalid_request: "q is required and page must be an integer from 1 to 5.",
  unauthorized: "Missing or invalid API key.",
  payment_required: "This key has no credits remaining.",
  invalid_asin: "ASIN must be 10 alphanumeric characters.",
  not_found: "This Amazon URL could not be resolved.",
  product_unavailable: "This product is gone or suppressed.",
  marketplace_unsupported: "Only Amazon.com (US) is supported in v1.",
  not_implemented: "This endpoint is not implemented.",
  rate_limited: "Rate limit exceeded.",
  upstream_blocked: "The upstream marketplace blocked this request.",
  internal: "Internal error.",
};

export function parseSearchQuery(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const q = value.trim().replace(/\s+/g, " ");
  return q === "" ? null : q;
}

export function parseSearchPage(value: string | number | undefined): number | null {
  if (value === undefined || value === "") {
    return 1;
  }
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 1 && value <= MAX_SEARCH_PAGE
      ? value
      : null;
  }
  if (!/^[1-9][0-9]*$/.test(value)) {
    return null;
  }
  const page = Number(value);
  if (!Number.isSafeInteger(page) || page > MAX_SEARCH_PAGE) {
    return null;
  }
  return page;
}

export function searchCreditCost(resultCount: number): number {
  return resultCount * SEARCH_CREDIT_PER_RESULT;
}

export async function searchProducts(input: SearchInput): Promise<SearchOutcome> {
  const requestId = input.requestId ?? newRequestId();
  const q = parseSearchQuery(input.q);
  if (q === null) {
    return fail("invalid_request", requestId, "q is required.");
  }
  const page = parseSearchPage(input.page);
  if (page === null) {
    return fail(
      "invalid_request",
      requestId,
      `page must be an integer from 1 to ${MAX_SEARCH_PAGE}.`,
    );
  }
  const parsedFields = parseFields(input.fields, SEARCH_PAGE_FIELD_SCHEMA);
  if (!parsedFields.ok) {
    return fail("invalid_request", requestId, parsedFields.message);
  }

  const remaining = getCredits(input.db, input.key.id);
  if (remaining === null) {
    return fail("unauthorized", requestId);
  }
  if (remaining < SEARCH_CREDIT_PER_RESULT) {
    return fail("payment_required", requestId);
  }

  const cacheKey = searchCacheKey(normalizeSearchCacheQ(q), page);
  const cached = getCacheEntry(input.db, cacheKey);
  if (cached.hit && cached.kind === "search") {
    const data = readCachedSearchPage(cached.body, q, page);
    if (data !== null) {
      return succeed(input, {
        data,
        cached: true,
        requestId,
        upstreamMs: 0,
        remaining,
        paths: parsedFields.paths,
      });
    }
  }

  const started = performance.now();
  let adapterResult;
  try {
    adapterResult = await input.adapter.fetchSearch({ q, page });
  } catch {
    return fail("internal", requestId);
  }
  const upstreamMs = Math.max(0, Math.round(performance.now() - started));

  if (!adapterResult.ok) {
    return fail(adapterResult.code, requestId);
  }

  const pageData: SearchPage = {
    q,
    page,
    hasMore: adapterResult.page.hasMore,
    results: adapterResult.page.results.map(cloneSearchResult),
  };
  setSearchCache(input.db, cacheKey, JSON.stringify(pageData));
  return succeed(input, {
    data: pageData,
    cached: false,
    requestId,
    upstreamMs,
    remaining,
    paths: parsedFields.paths,
  });
}

function succeed(
  input: SearchInput,
  ready: {
    data: SearchPage;
    cached: boolean;
    requestId: string;
    upstreamMs: number;
    remaining: number;
    paths: string[] | null;
  },
): SearchOutcome {
  const credits = searchCreditCost(ready.data.results.length);
  if (credits > ready.remaining) {
    return fail("payment_required", ready.requestId);
  }

  const skipCharge =
    input.key.prefix === "ak_test" && process.env.ASINAPI_TEST_KEYS_FREE === "1";
  let creditsCharged = 0;
  if (!skipCharge && credits > 0) {
    const charge = chargeCredits(input.db, {
      keyId: input.key.id,
      route: SEARCH_ROUTE,
      credits,
      cached: ready.cached,
    });
    if (!charge.ok) {
      return fail("payment_required", ready.requestId);
    }
    creditsCharged = charge.charged;
  }

  const data =
    ready.paths === null ? ready.data : projectFields(ready.data, ready.paths);
  return {
    data,
    meta: {
      cached: ready.cached,
      creditsCharged,
      requestId: ready.requestId,
      upstreamMs: ready.upstreamMs,
    },
  };
}

function fail(code: ErrorCode, requestId: string, message?: string): Err {
  return {
    error: {
      code,
      message: message ?? ERROR_MESSAGE[code],
      retryable: isRetryableCode(code),
    },
    meta: { creditsCharged: 0, requestId },
  };
}

function newRequestId(): string {
  return `req_${randomUUID()}`;
}

export function normalizeSearchCacheQ(q: string): string {
  return q.trim().replace(/\s+/g, " ").toLowerCase();
}

function cloneSearchResult(result: SearchResult): SearchResult {
  return {
    asin: result.asin,
    title: result.title,
    price: {
      amount: result.price.amount,
      currency: "USD",
      display: result.price.display,
      unavailable: result.price.unavailable,
    },
    rating: {
      average: result.rating.average,
      count: result.rating.count,
    },
    url: result.url,
    image: result.image,
  };
}

function readCachedSearchPage(
  body: string,
  q: string,
  page: number,
): SearchPage | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!isRecord(parsed) || !Array.isArray(parsed.results)) {
      return null;
    }
    if (typeof parsed.hasMore !== "boolean") {
      return null;
    }
    const results: SearchResult[] = [];
    for (const item of parsed.results) {
      const result = readCachedSearchResult(item);
      if (result === null) {
        return null;
      }
      results.push(result);
    }
    return {
      q,
      page,
      hasMore: parsed.hasMore,
      results,
    };
  } catch {
    return null;
  }
}

function readCachedSearchResult(value: unknown): SearchResult | null {
  if (!isRecord(value) || typeof value.asin !== "string") {
    return null;
  }
  if (typeof value.title !== "string" || value.title === "") {
    return null;
  }
  if (typeof value.url !== "string") {
    return null;
  }
  if (!isRecord(value.price) || value.price.currency !== "USD") {
    return null;
  }
  if (typeof value.price.unavailable !== "boolean") {
    return null;
  }
  if (!isRecord(value.rating)) {
    return null;
  }
  return {
    asin: value.asin,
    title: value.title,
    price: {
      amount: typeof value.price.amount === "number" ? value.price.amount : null,
      currency: "USD",
      display: typeof value.price.display === "string" ? value.price.display : null,
      unavailable: value.price.unavailable,
    },
    rating: {
      average: typeof value.rating.average === "number" ? value.rating.average : null,
      count: typeof value.rating.count === "number" ? value.rating.count : null,
    },
    url: value.url,
    image: typeof value.image === "string" ? value.image : null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
