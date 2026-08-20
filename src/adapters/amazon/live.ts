import { marketplaceForHost, parseAmazonUrl } from "../../core/product.js";
import type { ReviewSort } from "../../types.js";
import type {
  AdapterResult,
  ProductAdapter,
  ResolveShortResult,
  ReviewsAdapterResult,
  SearchAdapterResult,
} from "../types.js";
import { parseProductHtml, parseReviewsHtml, parseSearchHtml } from "./parse.js";

const MAX_REDIRECTS = 8;
const DEFAULT_TIMEOUT_MS = 15_000;
const AMAZON_ORIGIN = "https://www.amazon.com";

const DEFAULT_HEADERS: Record<string, string> = {
  accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "user-agent":
    "Mozilla/5.0 (compatible; AsinAPI/0.1; +https://github.com/tangpingqingwa/asinapi)",
};

export type LiveFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export type LiveAmazonAdapterOptions = {
  fetch?: LiveFetch;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  timeoutMs?: number;
};

export function liveProductUrl(asin: string): string {
  return `${AMAZON_ORIGIN}/dp/${asin}`;
}

export function liveReviewsUrl(
  asin: string,
  page: number,
  sort: ReviewSort,
): string {
  const params = new URLSearchParams({
    pageNumber: String(page),
    sortBy: sort,
  });
  return `${AMAZON_ORIGIN}/product-reviews/${asin}?${params.toString()}`;
}

export function liveSearchUrl(q: string, page: number): string {
  const params = new URLSearchParams({ k: q, page: String(page) });
  return `${AMAZON_ORIGIN}/s?${params.toString()}`;
}

export function liveShortUrl(code: string): string {
  return `https://amzn.to/${code}`;
}

export function createLiveAmazonAdapter(
  options: LiveAmazonAdapterOptions = {},
): ProductAdapter {
  const env = options.env ?? process.env;
  const fixtureOnly =
    env.ASINAPI_FIXTURE_ONLY === "1" || process.env.ASINAPI_FIXTURE_ONLY === "1";
  if (options.fetch === undefined && fixtureOnly) {
    throw new Error(
      "live Amazon adapter requires an injected fetch when ASINAPI_FIXTURE_ONLY=1",
    );
  }
  const fetchFn = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const request = async (
    url: string,
    init: RequestInit,
  ): Promise<Response> => {
    const headers = new Headers(DEFAULT_HEADERS);
    if (init.headers !== undefined) {
      const extra = new Headers(init.headers);
      extra.forEach((value, key) => {
        headers.set(key, value);
      });
    }
    return fetchFn(url, {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(timeoutMs),
    });
  };

  return {
    async resolveShortCode(code: string): Promise<ResolveShortResult> {
      return followShortLink(request, code);
    },
    async fetchProduct(input): Promise<AdapterResult> {
      const url = input.url ?? liveProductUrl(input.asin);
      const html = await getHtml(request, url);
      if (!html.ok) {
        return html;
      }
      const parsed = parseProductHtml(input.asin, html.body);
      if (!parsed.ok) {
        return parsed;
      }
      return {
        ok: true,
        product: {
          ...parsed.product,
          fetchedAt: now().toISOString(),
        },
      };
    },
    async fetchReviews(input): Promise<ReviewsAdapterResult> {
      const url = liveReviewsUrl(input.asin, input.page, input.sort);
      const html = await getHtml(request, url);
      if (!html.ok) {
        if (html.code === "product_unavailable") {
          return {
            ok: true,
            page: { page: input.page, hasMore: false, reviews: [] },
          };
        }
        return html;
      }
      return parseReviewsHtml(input.page, html.body);
    },
    async fetchSearch(input): Promise<SearchAdapterResult> {
      const url = liveSearchUrl(input.q, input.page);
      const html = await getHtml(request, url);
      if (!html.ok) {
        if (html.code === "product_unavailable") {
          return {
            ok: true,
            page: { q: input.q, page: input.page, hasMore: false, results: [] },
          };
        }
        return html;
      }
      return parseSearchHtml(input.q, input.page, html.body);
    },
  };
}

type HtmlResult =
  | { ok: true; body: string }
  | {
      ok: false;
      code: "product_unavailable" | "upstream_blocked" | "marketplace_unsupported";
    };

async function getHtml(
  request: (url: string, init: RequestInit) => Promise<Response>,
  url: string,
): Promise<HtmlResult> {
  const hostError = marketplaceErrorForUrl(url);
  if (hostError !== null) {
    return { ok: false, code: hostError };
  }
  let response: Response;
  try {
    response = await request(url, { method: "GET", redirect: "follow" });
  } catch {
    return { ok: false, code: "upstream_blocked" };
  }
  const finalUrl = response.url !== "" ? response.url : url;
  const finalHostError = marketplaceErrorForUrl(finalUrl);
  if (finalHostError !== null) {
    return { ok: false, code: finalHostError };
  }
  if (isBlockedStatus(response.status)) {
    return { ok: false, code: "upstream_blocked" };
  }
  if (isUnavailableStatus(response.status)) {
    return { ok: false, code: "product_unavailable" };
  }
  if (!response.ok) {
    return { ok: false, code: "upstream_blocked" };
  }
  let body: string;
  try {
    body = await response.text();
  } catch {
    return { ok: false, code: "upstream_blocked" };
  }
  return { ok: true, body };
}

async function followShortLink(
  request: (url: string, init: RequestInit) => Promise<Response>,
  code: string,
): Promise<ResolveShortResult> {
  const trimmed = code.trim();
  if (trimmed === "") {
    return { ok: false, code: "not_found" };
  }

  const seen = new Set<string>();
  let current = liveShortUrl(trimmed);

  for (let hop = 0; hop < MAX_REDIRECTS; hop += 1) {
    if (seen.has(current)) {
      return { ok: false, code: "not_found" };
    }
    seen.add(current);

    const hostError = marketplaceErrorForUrl(current);
    if (hostError !== null) {
      return { ok: false, code: hostError };
    }

    let response: Response;
    try {
      response = await request(current, { method: "HEAD", redirect: "manual" });
      if (response.status === 405 || response.status === 501) {
        response = await request(current, { method: "GET", redirect: "manual" });
      }
    } catch {
      return { ok: false, code: "upstream_blocked" };
    }

    if (isBlockedStatus(response.status)) {
      return { ok: false, code: "upstream_blocked" };
    }
    if (isUnavailableStatus(response.status)) {
      return { ok: false, code: "not_found" };
    }

    const location = response.headers.get("location");
    if (location !== null && location !== "" && isRedirectStatus(response.status)) {
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        return { ok: false, code: "not_found" };
      }
      current = next.toString();
      continue;
    }

    const finalUrl = response.url !== "" ? response.url : current;
    return resolveFinalUrl(finalUrl);
  }

  return { ok: false, code: "not_found" };
}

function resolveFinalUrl(raw: string): ResolveShortResult {
  const hostError = marketplaceErrorForUrl(raw);
  if (hostError !== null) {
    return { ok: false, code: hostError };
  }
  const parsed = parseAmazonUrl(raw);
  if (!parsed.ok) {
    if (
      parsed.code === "marketplace_unsupported" ||
      parsed.code === "invalid_asin"
    ) {
      return { ok: false, code: parsed.code };
    }
    return { ok: false, code: "not_found" };
  }
  if (parsed.kind === "short") {
    return { ok: false, code: "not_found" };
  }
  return { ok: true, asin: parsed.asin };
}

function marketplaceErrorForUrl(
  raw: string,
): "marketplace_unsupported" | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (marketplaceForHost(parsed.hostname.toLowerCase()) === "unsupported") {
    return "marketplace_unsupported";
  }
  return null;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function isBlockedStatus(status: number): boolean {
  return (
    status === 401 ||
    status === 403 ||
    status === 407 ||
    status === 429 ||
    status === 451 ||
    status === 503
  );
}

function isUnavailableStatus(status: number): boolean {
  return status === 404 || status === 410;
}
