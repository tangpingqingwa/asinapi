import type { AsinApiDb } from "../db.js";
import type { ErrorCode } from "../types.js";

/** Price / unavailable is the shorter product TTL (SPEC §6). */
export const PRODUCT_TTL_MS = 6 * 60 * 60 * 1000;
export const PRODUCT_UNAVAILABLE_TTL_MS = 12 * 60 * 60 * 1000;
/** Reviews cache by (asin, page, sort) (SPEC §6). */
export const REVIEWS_TTL_MS = 24 * 60 * 60 * 1000;

export type CacheTombstoneCode = Extract<ErrorCode, "product_unavailable">;

export type CacheLookup =
  | { hit: false }
  | { hit: true; kind: "product"; body: string }
  | { hit: true; kind: "reviews"; body: string }
  | { hit: true; kind: "tombstone"; errorCode: CacheTombstoneCode };

type CacheRow = {
  kind: string;
  body: string | null;
  error_code: string | null;
  expires_at: string;
};

export function productCacheKey(asin: string): string {
  return `product:US:${asin}`;
}

export function reviewsCacheKey(
  asin: string,
  page: number,
  sort: string,
): string {
  return `reviews:US:${asin}:${page}:${sort}`;
}

export function getCacheEntry(
  db: AsinApiDb,
  cacheKey: string,
  now: Date = new Date(),
): CacheLookup {
  const row = db
    .prepare<[string], CacheRow>(
      `SELECT kind, body, error_code, expires_at
       FROM cache_entries WHERE cache_key = ?`,
    )
    .get(cacheKey);
  if (row === undefined || row.expires_at <= now.toISOString()) {
    return { hit: false };
  }
  if (row.kind === "product" && row.body !== null) {
    return { hit: true, kind: "product", body: row.body };
  }
  if (row.kind === "reviews" && row.body !== null) {
    return { hit: true, kind: "reviews", body: row.body };
  }
  if (row.kind === "tombstone" && row.error_code === "product_unavailable") {
    return { hit: true, kind: "tombstone", errorCode: row.error_code };
  }
  return { hit: false };
}

export function setProductCache(
  db: AsinApiDb,
  cacheKey: string,
  body: string,
  now: Date = new Date(),
  ttlMs: number = PRODUCT_TTL_MS,
): void {
  upsertCache(db, {
    cacheKey,
    kind: "product",
    body,
    errorCode: null,
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  });
}

export function setReviewsCache(
  db: AsinApiDb,
  cacheKey: string,
  body: string,
  now: Date = new Date(),
  ttlMs: number = REVIEWS_TTL_MS,
): void {
  upsertCache(db, {
    cacheKey,
    kind: "reviews",
    body,
    errorCode: null,
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  });
}

export function setCacheTombstone(
  db: AsinApiDb,
  cacheKey: string,
  errorCode: CacheTombstoneCode,
  now: Date = new Date(),
  ttlMs: number = PRODUCT_UNAVAILABLE_TTL_MS,
): void {
  upsertCache(db, {
    cacheKey,
    kind: "tombstone",
    body: null,
    errorCode,
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  });
}

function upsertCache(
  db: AsinApiDb,
  entry: {
    cacheKey: string;
    kind: string;
    body: string | null;
    errorCode: string | null;
    expiresAt: string;
  },
): void {
  db.prepare(
    `INSERT INTO cache_entries (cache_key, kind, body, error_code, expires_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET
       kind = excluded.kind,
       body = excluded.body,
       error_code = excluded.error_code,
       expires_at = excluded.expires_at`,
  ).run(entry.cacheKey, entry.kind, entry.body, entry.errorCode, entry.expiresAt);
}
