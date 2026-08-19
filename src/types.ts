export type ErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "payment_required"
  | "invalid_asin"
  | "not_found"
  | "product_unavailable"
  | "marketplace_unsupported"
  | "not_implemented"
  | "rate_limited"
  | "upstream_blocked"
  | "internal";

export const ERROR_CODES: readonly ErrorCode[] = [
  "invalid_request",
  "unauthorized",
  "payment_required",
  "invalid_asin",
  "not_found",
  "product_unavailable",
  "marketplace_unsupported",
  "not_implemented",
  "rate_limited",
  "upstream_blocked",
  "internal",
];

export type ProductPrice = {
  amount: number | null;
  currency: "USD";
  display: string | null;
  unavailable: boolean;
};

export type ProductRating = {
  average: number | null;
  count: number | null;
};

export type ProductBsr = {
  rank: number;
  category: string;
};

export type Product = {
  asin: string;
  marketplace: "US";
  title: string;
  brand: string | null;
  url: string;
  images: string[];
  price: ProductPrice;
  rating: ProductRating;
  bullets: string[];
  description: string | null;
  categoryPath: string[];
  bsr: ProductBsr[] | null;
  attributes: Record<string, string>;
  fetchedAt: string;
};

export const PRODUCT_FIELDS = [
  "asin",
  "marketplace",
  "title",
  "brand",
  "url",
  "images",
  "price",
  "rating",
  "bullets",
  "description",
  "categoryPath",
  "bsr",
  "attributes",
  "fetchedAt",
] as const satisfies readonly (keyof Product)[];

export type ReviewSort = "helpful" | "recent";

export const REVIEW_SORTS = ["helpful", "recent"] as const satisfies readonly ReviewSort[];

export type Review = {
  id: string | null;
  title: string | null;
  body: string;
  stars: number;
  createdAt: string | null;
  verified: boolean | null;
  author: string | null;
  country: string | null;
};

export const REVIEW_FIELDS = [
  "id",
  "title",
  "body",
  "stars",
  "createdAt",
  "verified",
  "author",
  "country",
] as const satisfies readonly (keyof Review)[];

export type ReviewPage = {
  page: number;
  hasMore: boolean;
  reviews: Review[];
};

export const REVIEW_PAGE_FIELDS = [
  "page",
  "hasMore",
  "reviews",
] as const satisfies readonly (keyof ReviewPage)[];

export type SearchResult = {
  asin: string;
  title: string;
  price: ProductPrice;
  rating: ProductRating;
  url: string;
  image: string | null;
};

export const SEARCH_RESULT_FIELDS = [
  "asin",
  "title",
  "price",
  "rating",
  "url",
  "image",
] as const satisfies readonly (keyof SearchResult)[];

export type SearchPage = {
  q: string;
  page: number;
  hasMore: boolean;
  results: SearchResult[];
};

export const SEARCH_PAGE_FIELDS = [
  "q",
  "page",
  "hasMore",
  "results",
] as const satisfies readonly (keyof SearchPage)[];

export type Ok<T> = {
  data: T;
  meta: { cached: boolean; creditsCharged: number; requestId: string; upstreamMs: number };
};

export type Err = {
  error: { code: ErrorCode; message: string; retryable: boolean };
  meta: { creditsCharged: 0; requestId: string };
};
