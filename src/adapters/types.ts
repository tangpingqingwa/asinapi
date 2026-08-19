import type { Product } from "../types.js";

export type AdapterRequest = {
  asin: string;
  url?: string;
};

export type AdapterFailureCode =
  | "product_unavailable"
  | "upstream_blocked"
  | "marketplace_unsupported";

export type AdapterOk = {
  ok: true;
  product: Product;
};

export type AdapterErr = {
  ok: false;
  code: AdapterFailureCode;
};

export type AdapterResult = AdapterOk | AdapterErr;

export type ProductAdapter = {
  /** Map an amzn.to path to a canonical ASIN when the fixture already resolved it. */
  resolveShortCode(code: string): string | null;
  fetchProduct(request: AdapterRequest): Promise<AdapterResult>;
};
