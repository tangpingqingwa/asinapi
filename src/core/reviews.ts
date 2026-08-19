import { randomUUID } from "node:crypto";
import type { ProductAdapter } from "../adapters/types.js";
import { chargeCredits, getCredits, REVIEW_CREDIT_COST } from "../billing/credits.js";
import type { Key } from "../billing/keys.js";
import {
  getCacheEntry,
  reviewsCacheKey,
  setReviewsCache,
} from "../cache/store.js";
import type { AsinApiDb } from "../db.js";
import type {
  Err,
  ErrorCode,
  Ok,
  Review,
  ReviewPage,
  ReviewSort,
} from "../types.js";
import { isRetryableCode, normalizeAsin } from "./product.js";

export const REVIEWS_ROUTE = "/v1/products/{asin}/reviews" as const;

export const DEFAULT_REVIEW_SORT: ReviewSort = "helpful";

export type ReviewsOutcome = Ok<ReviewPage> | Err;

export type GetReviewsInput = {
  db: AsinApiDb;
  adapter: ProductAdapter;
  key: Key;
  asin: string;
  page?: string | number;
  sort?: string;
  requestId?: string;
};

const ERROR_MESSAGE: Record<ErrorCode, string> = {
  invalid_request: "page must be a 1-based integer and sort must be helpful or recent.",
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

export function parseReviewPage(value: string | number | undefined): number | null {
  if (value === undefined || value === "") {
    return 1;
  }
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 1 ? value : null;
  }
  if (!/^[1-9][0-9]*$/.test(value)) {
    return null;
  }
  const page = Number(value);
  return Number.isSafeInteger(page) ? page : null;
}

export function parseReviewSort(value: string | undefined): ReviewSort | null {
  if (value === undefined || value === "") {
    return DEFAULT_REVIEW_SORT;
  }
  if (value === "helpful" || value === "recent") {
    return value;
  }
  return null;
}

export async function getReviews(input: GetReviewsInput): Promise<ReviewsOutcome> {
  const requestId = input.requestId ?? newRequestId();
  const asin = normalizeAsin(input.asin);
  if (asin === null) {
    return fail("invalid_asin", requestId);
  }

  const page = parseReviewPage(input.page);
  if (page === null) {
    return fail("invalid_request", requestId, "page must be a 1-based integer.");
  }
  const sort = parseReviewSort(input.sort);
  if (sort === null) {
    return fail(
      "invalid_request",
      requestId,
      "sort must be helpful or recent.",
    );
  }

  const remaining = getCredits(input.db, input.key.id);
  if (remaining === null) {
    return fail("unauthorized", requestId);
  }
  if (remaining < REVIEW_CREDIT_COST) {
    return fail("payment_required", requestId);
  }

  const cacheKey = reviewsCacheKey(asin, page, sort);
  const cached = getCacheEntry(input.db, cacheKey);
  if (cached.hit && cached.kind === "reviews") {
    const data = readCachedReviewPage(cached.body, page);
    if (data !== null) {
      return succeed(input, {
        data,
        cached: true,
        requestId,
        upstreamMs: 0,
      });
    }
  }

  const started = performance.now();
  let adapterResult;
  try {
    adapterResult = await input.adapter.fetchReviews({ asin, page, sort });
  } catch {
    return fail("internal", requestId);
  }
  const upstreamMs = Math.max(0, Math.round(performance.now() - started));

  if (!adapterResult.ok) {
    return fail(adapterResult.code, requestId);
  }

  const pageData: ReviewPage = {
    page,
    hasMore: adapterResult.page.hasMore,
    reviews: adapterResult.page.reviews.map(cloneReview),
  };
  setReviewsCache(input.db, cacheKey, JSON.stringify(pageData));
  return succeed(input, {
    data: pageData,
    cached: false,
    requestId,
    upstreamMs,
  });
}

function succeed(
  input: GetReviewsInput,
  ready: {
    data: ReviewPage;
    cached: boolean;
    requestId: string;
    upstreamMs: number;
  },
): Ok<ReviewPage> {
  const skipCharge =
    input.key.prefix === "ak_test" && process.env.ASINAPI_TEST_KEYS_FREE === "1";
  let creditsCharged = 0;
  if (!skipCharge) {
    const charge = chargeCredits(input.db, {
      keyId: input.key.id,
      route: REVIEWS_ROUTE,
      credits: REVIEW_CREDIT_COST,
      cached: ready.cached,
    });
    creditsCharged = charge.ok ? charge.charged : 0;
  }
  return {
    data: ready.data,
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

function cloneReview(review: Review): Review {
  return {
    id: review.id,
    title: review.title,
    body: review.body,
    stars: review.stars,
    createdAt: review.createdAt,
    verified: review.verified,
    author: review.author,
    country: review.country,
  };
}

function readCachedReviewPage(body: string, page: number): ReviewPage | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!isRecord(parsed) || !Array.isArray(parsed.reviews)) {
      return null;
    }
    if (typeof parsed.hasMore !== "boolean") {
      return null;
    }
    const reviews: Review[] = [];
    for (const item of parsed.reviews) {
      const review = readCachedReview(item);
      if (review === null) {
        return null;
      }
      reviews.push(review);
    }
    return {
      page,
      hasMore: parsed.hasMore,
      reviews,
    };
  } catch {
    return null;
  }
}

function readCachedReview(value: unknown): Review | null {
  if (!isRecord(value) || typeof value.body !== "string") {
    return null;
  }
  if (typeof value.stars !== "number" || value.stars < 1 || value.stars > 5) {
    return null;
  }
  return {
    id: nullableString(value.id),
    title: nullableString(value.title),
    body: value.body,
    stars: value.stars,
    createdAt: nullableString(value.createdAt),
    verified: nullableBoolean(value.verified),
    author: nullableString(value.author),
    country: nullableString(value.country),
  };
}

function nullableString(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  return typeof value === "string" ? value : null;
}

function nullableBoolean(value: unknown): boolean | null {
  if (value === null) {
    return null;
  }
  return typeof value === "boolean" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
