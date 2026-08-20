import { selectAmazonAdapter } from "../config.js";
import { createFixtureAdapter } from "./amazon/fixture.js";
import {
  createLiveAmazonAdapter,
  type LiveFetch,
} from "./amazon/live.js";
import type { ProductAdapter } from "./types.js";

export type {
  AdapterErr,
  AdapterFailureCode,
  AdapterOk,
  AdapterRequest,
  AdapterResult,
  ProductAdapter,
  ResolveShortErr,
  ResolveShortOk,
  ResolveShortResult,
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
export { createLiveAmazonAdapter } from "./amazon/live.js";

export type CreateAppAdapterOptions = {
  env?: NodeJS.ProcessEnv;
  fetch?: LiveFetch;
};

/** Fixture by default. Live Amazon only when ASINAPI_ADAPTER=live and CI did not set ASINAPI_FIXTURE_ONLY=1. */
export function createAppAdapter(
  options: CreateAppAdapterOptions = {},
): ProductAdapter {
  const env = options.env ?? process.env;
  if (selectAmazonAdapter(env) === "live") {
    return createLiveAmazonAdapter({ fetch: options.fetch, env });
  }
  return createFixtureAdapter();
}
