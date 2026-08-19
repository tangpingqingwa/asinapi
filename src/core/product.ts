import { randomUUID } from "node:crypto";
import type { ProductAdapter } from "../adapters/types.js";
import { chargeCredits, getCredits, PRODUCT_CREDIT_COST } from "../billing/credits.js";
import type { Key } from "../billing/keys.js";
import {
  getCacheEntry,
  productCacheKey,
  setCacheTombstone,
  setProductCache,
} from "../cache/store.js";
import type { AsinApiDb } from "../db.js";
import type { Err, ErrorCode, Ok, Product } from "../types.js";

export const PRODUCT_BY_ASIN_ROUTE = "/v1/products/{asin}" as const;
export const PRODUCT_BY_URL_ROUTE = "/v1/products/by-url" as const;

export const ASIN_RE = /^[A-Z0-9]{10}$/;

export type ProductOutcome = Ok<Product> | Err;

export type GetProductInput = {
  db: AsinApiDb;
  adapter: ProductAdapter;
  key: Key;
  asin: string;
  url?: string;
  route?: string;
  requestId?: string;
};

export type GetProductByUrlInput = {
  db: AsinApiDb;
  adapter: ProductAdapter;
  key: Key;
  url: string | undefined;
  requestId?: string;
};

export type ParsedAmazonUrl =
  | { ok: true; kind: "asin"; asin: string; url: string }
  | { ok: true; kind: "short"; code: string; url: string }
  | {
      ok: false;
      code: Extract<
        ErrorCode,
        "invalid_request" | "invalid_asin" | "marketplace_unsupported"
      >;
      message: string;
    };

const ERROR_MESSAGE: Record<ErrorCode, string> = {
  invalid_request: "Provide a url query parameter.",
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

const US_HOSTS = new Set([
  "amazon.com",
  "www.amazon.com",
  "smile.amazon.com",
  "m.amazon.com",
]);

const SHORT_HOSTS = new Set(["amzn.to", "www.amzn.to"]);

const NON_US_HOST =
  /(^|\.)amazon\.(co\.uk|com\.au|com\.be|com\.br|com\.mx|com\.tr|co\.jp|com|de|fr|it|es|ca|in|nl|se|pl|sg|ae|sa|eg)$/i;

export function isRetryableCode(code: ErrorCode): boolean {
  return code === "rate_limited" || code === "upstream_blocked" || code === "internal";
}

export function normalizeAsin(value: string): string | null {
  const asin = value.trim().toUpperCase();
  return ASIN_RE.test(asin) ? asin : null;
}

export function parseAmazonUrl(raw: string | undefined): ParsedAmazonUrl {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === "") {
    return {
      ok: false,
      code: "invalid_request",
      message: ERROR_MESSAGE.invalid_request,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(hasScheme(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return {
      ok: false,
      code: "invalid_request",
      message: "url is not a valid URL.",
    };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      code: "invalid_request",
      message: "url is not a valid URL.",
    };
  }

  const host = parsed.hostname.toLowerCase();
  if (SHORT_HOSTS.has(host)) {
    const code = parsed.pathname.replace(/^\/+|\/+$/g, "");
    if (code === "") {
      return {
        ok: false,
        code: "invalid_request",
        message: "amzn.to URL is missing a short code.",
      };
    }
    return { ok: true, kind: "short", code, url: parsed.toString() };
  }

  const marketplace = marketplaceForHost(host);
  if (marketplace === "unsupported") {
    return {
      ok: false,
      code: "marketplace_unsupported",
      message: ERROR_MESSAGE.marketplace_unsupported,
    };
  }
  if (marketplace === null) {
    return {
      ok: false,
      code: "invalid_request",
      message: "url is not an Amazon product URL.",
    };
  }

  const asin = extractAsin(parsed);
  if (asin === null) {
    return {
      ok: false,
      code: "invalid_asin",
      message: ERROR_MESSAGE.invalid_asin,
    };
  }
  return { ok: true, kind: "asin", asin, url: parsed.toString() };
}

export async function getProduct(input: GetProductInput): Promise<ProductOutcome> {
  const requestId = input.requestId ?? newRequestId();
  const asin = normalizeAsin(input.asin);
  if (asin === null) {
    return fail("invalid_asin", requestId);
  }
  return loadProduct(input, asin, requestId, input.route ?? PRODUCT_BY_ASIN_ROUTE);
}

export async function getProductByUrl(
  input: GetProductByUrlInput,
): Promise<ProductOutcome> {
  const requestId = input.requestId ?? newRequestId();
  const parsed = parseAmazonUrl(input.url);
  if (!parsed.ok) {
    return fail(parsed.code, requestId, parsed.message);
  }

  let asin: string;
  let url = parsed.url;
  if (parsed.kind === "short") {
    const resolved = input.adapter.resolveShortCode(parsed.code);
    if (resolved === null) {
      return fail("not_found", requestId);
    }
    asin = resolved;
    url = `https://www.amazon.com/dp/${asin}`;
  } else {
    asin = parsed.asin;
  }

  return loadProduct(
    {
      db: input.db,
      adapter: input.adapter,
      key: input.key,
      asin,
      url,
      requestId,
    },
    asin,
    requestId,
    PRODUCT_BY_URL_ROUTE,
  );
}

async function loadProduct(
  input: GetProductInput,
  asin: string,
  requestId: string,
  route: string,
): Promise<ProductOutcome> {
  const remaining = getCredits(input.db, input.key.id);
  if (remaining === null) {
    return fail("unauthorized", requestId);
  }
  if (remaining < PRODUCT_CREDIT_COST) {
    return fail("payment_required", requestId);
  }

  const cacheKey = productCacheKey(asin);
  const cached = getCacheEntry(input.db, cacheKey);
  if (cached.hit && cached.kind === "product") {
    const data = readCachedProduct(cached.body);
    if (data !== null) {
      return succeed(input, route, {
        data,
        cached: true,
        requestId,
        upstreamMs: 0,
      });
    }
  }
  if (cached.hit && cached.kind === "tombstone") {
    return fail(cached.errorCode, requestId);
  }

  const started = performance.now();
  let adapterResult;
  try {
    adapterResult = await input.adapter.fetchProduct({
      asin,
      url: input.url,
    });
  } catch {
    return fail("internal", requestId);
  }
  const upstreamMs = Math.max(0, Math.round(performance.now() - started));

  if (!adapterResult.ok) {
    if (adapterResult.code === "product_unavailable") {
      setCacheTombstone(input.db, cacheKey, adapterResult.code);
    }
    return fail(adapterResult.code, requestId);
  }

  if (adapterResult.product.title.trim() === "") {
    setCacheTombstone(input.db, cacheKey, "product_unavailable");
    return fail("product_unavailable", requestId);
  }

  const product: Product = {
    ...adapterResult.product,
    asin,
    marketplace: "US",
    url: adapterResult.product.url || `https://www.amazon.com/dp/${asin}`,
    images: adapterResult.product.images.slice(0, 10),
  };
  setProductCache(input.db, cacheKey, JSON.stringify(product));
  return succeed(input, route, {
    data: product,
    cached: false,
    requestId,
    upstreamMs,
  });
}

function succeed(
  input: GetProductInput,
  route: string,
  ready: {
    data: Product;
    cached: boolean;
    requestId: string;
    upstreamMs: number;
  },
): Ok<Product> {
  const skipCharge =
    input.key.prefix === "ak_test" && process.env.ASINAPI_TEST_KEYS_FREE === "1";
  let creditsCharged = 0;
  if (!skipCharge) {
    const charge = chargeCredits(input.db, {
      keyId: input.key.id,
      route,
      credits: PRODUCT_CREDIT_COST,
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

function marketplaceForHost(host: string): "US" | "unsupported" | null {
  if (US_HOSTS.has(host)) {
    return "US";
  }
  if (SHORT_HOSTS.has(host)) {
    return "US";
  }
  if (host === "amazon.com" || host.endsWith(".amazon.com")) {
    return "US";
  }
  if (NON_US_HOST.test(host)) {
    return "unsupported";
  }
  return null;
}

function extractAsin(url: URL): string | null {
  const path = url.pathname;
  const dp = /\/dp\/([A-Za-z0-9]{10})(?:[/?]|$)/i.exec(path);
  const gp = /\/gp\/product\/([A-Za-z0-9]{10})(?:[/?]|$)/i.exec(path);
  const query = url.searchParams.get("asin");
  const candidates = [dp?.[1], gp?.[1], query ?? undefined]
    .filter((value): value is string => value !== undefined)
    .map((value) => value.toUpperCase());
  if (candidates.length === 0) {
    return null;
  }
  const unique = new Set(candidates);
  if (unique.size !== 1) {
    return null;
  }
  const asin = candidates[0];
  if (asin === undefined || !ASIN_RE.test(asin)) {
    return null;
  }
  return asin;
}

function readCachedProduct(body: string): Product | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!isRecord(parsed) || typeof parsed.title !== "string" || parsed.title === "") {
      return null;
    }
    if (typeof parsed.asin !== "string" || !ASIN_RE.test(parsed.asin)) {
      return null;
    }
    return parsed as Product;
  } catch {
    return null;
  }
}

function hasScheme(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
