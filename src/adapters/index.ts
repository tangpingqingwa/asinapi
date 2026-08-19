import { createFixtureAdapter } from "./amazon/fixture.js";
import type { ProductAdapter } from "./types.js";

export type {
  AdapterErr,
  AdapterFailureCode,
  AdapterOk,
  AdapterRequest,
  AdapterResult,
  ProductAdapter,
  ReviewsAdapterErr,
  ReviewsAdapterOk,
  ReviewsAdapterRequest,
  ReviewsAdapterResult,
  SearchAdapterErr,
  SearchAdapterOk,
  SearchAdapterRequest,
  SearchAdapterResult,
} from "./types.js";
export { createFixtureAdapter } from "./amazon/fixture.js";
export { createLiveAmazonAdapter } from "./amazon/index.js";

/** PR 2 wires the fixture adapter only. Live Amazon is a later PR. */
export function createAppAdapter(): ProductAdapter {
  return createFixtureAdapter();
}
