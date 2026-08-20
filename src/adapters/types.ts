import type { Product, ReviewPage, ReviewSort, SearchPage } from "../types.js";

export type AdapterRequest = {
  asin: string;
  url?: string;
};

export type ReviewsAdapterRequest = {
  asin: string;
  page: number;
  sort: ReviewSort;
};

export type SearchAdapterRequest = {
  q: string;
  page: number;
};

export type AdapterFailureCode =
  | "product_unavailable"
  | "upstream_blocked"
  | "marketplace_unsupported";

export type ResolveShortOk = {
  ok: true;
  asin: string;
};

export type ResolveShortErr = {
  ok: false;
  code: Extract<
    AdapterFailureCode,
    "upstream_blocked" | "marketplace_unsupported"
  > | "invalid_asin" | "not_found";
};

export type ResolveShortResult = ResolveShortOk | ResolveShortErr;

export type AdapterOk = {
  ok: true;
  product: Product;
};

export type AdapterErr = {
  ok: false;
  code: AdapterFailureCode;
};

export type AdapterResult = AdapterOk | AdapterErr;

export type ReviewsAdapterOk = {
  ok: true;
  page: ReviewPage;
};

export type ReviewsAdapterErr = {
  ok: false;
  code: AdapterFailureCode;
};

export type ReviewsAdapterResult = ReviewsAdapterOk | ReviewsAdapterErr;

export type SearchAdapterOk = {
  ok: true;
  page: SearchPage;
};

export type SearchAdapterErr = {
  ok: false;
  code: AdapterFailureCode;
};

export type SearchAdapterResult = SearchAdapterOk | SearchAdapterErr;

export type ProductAdapter = {
  /** Fixture map, or live HEAD-follow of amzn.to. Never invents an ASIN. */
  resolveShortCode(code: string): ResolveShortResult | Promise<ResolveShortResult>;
  fetchProduct(request: AdapterRequest): Promise<AdapterResult>;
  fetchReviews(request: ReviewsAdapterRequest): Promise<ReviewsAdapterResult>;
  fetchSearch(request: SearchAdapterRequest): Promise<SearchAdapterResult>;
};
