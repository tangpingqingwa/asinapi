import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReviewPage, ReviewSort, SearchPage } from "../../types.js";
import type {
  AdapterResult,
  ProductAdapter,
  ReviewsAdapterResult,
  SearchAdapterResult,
} from "../types.js";
import {
  isBlocked,
  isUnavailablePage,
  parseProductHtml,
  parseReviewsHtml,
  parseSearchHtml,
} from "./parse.js";

export const DEFAULT_FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../tests/fixtures",
);

export const DEFAULT_HTML_DIR = join(DEFAULT_FIXTURE_DIR, "html");

export {
  isBlocked,
  isUnavailablePage,
  parseProductHtml,
  parseReviewsHtml,
  parseSearchHtml,
} from "./parse.js";

type FixtureIndex = {
  htmlByAsin: Map<string, string>;
  shortToAsin: Map<string, string>;
  reviewsHtml: Map<string, string>;
  searchHtml: Map<string, string>;
};

const SEARCH_FILE_RE = /^([a-z0-9][a-z0-9-]*)\.p([1-9][0-9]*)\.html$/i;

const REVIEW_FILE_RE =
  /^([A-Za-z0-9]{10})\.p([1-9][0-9]*)\.(helpful|recent)\.html$/i;

export type FixtureAdapterOptions = {
  dir?: string;
  htmlDir?: string;
};

export function createFixtureAdapter(
  options: FixtureAdapterOptions = {},
): ProductAdapter {
  const index = loadFixtureIndex(
    options.dir ?? DEFAULT_FIXTURE_DIR,
    options.htmlDir ?? DEFAULT_HTML_DIR,
  );
  return {
    resolveShortCode(code: string) {
      const asin = index.shortToAsin.get(code);
      if (asin === undefined) {
        return { ok: false as const, code: "not_found" as const };
      }
      return { ok: true as const, asin };
    },
    async fetchProduct(request): Promise<AdapterResult> {
      const html = index.htmlByAsin.get(request.asin);
      if (html === undefined) {
        return { ok: false, code: "product_unavailable" };
      }
      return parseProductHtml(request.asin, html);
    },
    async fetchReviews(request): Promise<ReviewsAdapterResult> {
      const productHtml = index.htmlByAsin.get(request.asin);
      if (productHtml === undefined) {
        return { ok: false, code: "product_unavailable" };
      }
      if (isBlocked(productHtml)) {
        return { ok: false, code: "upstream_blocked" };
      }
      if (isUnavailablePage(productHtml)) {
        return { ok: false, code: "product_unavailable" };
      }
      const reviewHtml = index.reviewsHtml.get(
        reviewsFixtureKey(request.asin, request.page, request.sort),
      );
      if (reviewHtml === undefined) {
        return {
          ok: true,
          page: emptyReviewPage(request.page),
        };
      }
      return parseReviewsHtml(request.page, reviewHtml);
    },
    async fetchSearch(request): Promise<SearchAdapterResult> {
      const html = index.searchHtml.get(
        searchFixtureKey(request.q, request.page),
      );
      if (html === undefined) {
        return { ok: true, page: emptySearchPage(request.q, request.page) };
      }
      return parseSearchHtml(request.q, request.page, html);
    },
  };
}

export function reviewsFixtureKey(
  asin: string,
  page: number,
  sort: ReviewSort,
): string {
  return `${asin.toUpperCase()}:${page}:${sort}`;
}

export function normalizeSearchSlug(q: string): string {
  return q
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

export function searchFixtureKey(q: string, page: number): string {
  return `${normalizeSearchSlug(q)}:${page}`;
}

export function loadFixtureIndex(dir: string, htmlDir: string): FixtureIndex {
  const htmlByAsin = new Map<string, string>();
  const shortToAsin = new Map<string, string>();
  const reviewsHtml = new Map<string, string>();
  const searchHtml = new Map<string, string>();

  const productFileRe = /^[A-Za-z0-9]{10}\.html$/;
  const htmlFiles = readdirSync(htmlDir)
    .filter((name) => productFileRe.test(name))
    .sort();
  for (const file of htmlFiles) {
    const asin = file.replace(/\.html$/, "").toUpperCase();
    if (htmlByAsin.has(asin)) {
      throw new Error(`duplicate fixture HTML for ${asin}`);
    }
    htmlByAsin.set(asin, readFileSync(join(htmlDir, file), "utf8"));
  }

  const reviewsDir = join(htmlDir, "reviews");
  if (existsSync(reviewsDir)) {
    const reviewFiles = readdirSync(reviewsDir)
      .filter((name) => name.endsWith(".html"))
      .sort();
    for (const file of reviewFiles) {
      const parsed = REVIEW_FILE_RE.exec(file);
      if (parsed === null || parsed[1] === undefined || parsed[2] === undefined) {
        throw new Error(`review fixture name must be ASIN.pN.sort.html: ${file}`);
      }
      const asin = parsed[1].toUpperCase();
      const page = Number(parsed[2]);
      const sort = parsed[3]?.toLowerCase() as ReviewSort;
      const key = reviewsFixtureKey(asin, page, sort);
      if (reviewsHtml.has(key)) {
        throw new Error(`duplicate review fixture for ${key}`);
      }
      reviewsHtml.set(key, readFileSync(join(reviewsDir, file), "utf8"));
    }
  }

  const searchDir = join(htmlDir, "search");
  if (existsSync(searchDir)) {
    const searchFiles = readdirSync(searchDir)
      .filter((name) => name.endsWith(".html"))
      .sort();
    for (const file of searchFiles) {
      const parsed = SEARCH_FILE_RE.exec(file);
      if (parsed === null || parsed[1] === undefined || parsed[2] === undefined) {
        throw new Error(`search fixture name must be slug.pN.html: ${file}`);
      }
      const slug = parsed[1].toLowerCase();
      const page = Number(parsed[2]);
      const key = `${slug}:${page}`;
      if (searchHtml.has(key)) {
        throw new Error(`duplicate search fixture for ${key}`);
      }
      searchHtml.set(key, readFileSync(join(searchDir, file), "utf8"));
    }
  }

  const shortPath = join(dir, "short-links.json");
  const raw: unknown = JSON.parse(readFileSync(shortPath, "utf8"));
  if (!isRecord(raw)) {
    throw new Error("short-links.json must be an object");
  }
  for (const [code, asin] of Object.entries(raw)) {
    if (typeof asin !== "string") {
      throw new Error(`short-links.json ${code} must be an ASIN string`);
    }
    if (shortToAsin.has(code)) {
      throw new Error(`duplicate short code ${code}`);
    }
    shortToAsin.set(code, asin.toUpperCase());
  }

  return { htmlByAsin, shortToAsin, reviewsHtml, searchHtml };
}

function emptyReviewPage(page: number): ReviewPage {
  return { page, hasMore: false, reviews: [] };
}

function emptySearchPage(q: string, page: number): SearchPage {
  return { q, page, hasMore: false, results: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
