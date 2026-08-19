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

export type Ok<T> = {
  data: T;
  meta: { cached: boolean; creditsCharged: number; requestId: string; upstreamMs: number };
};

export type Err = {
  error: { code: ErrorCode; message: string; retryable: boolean };
  meta: { creditsCharged: 0; requestId: string };
};
