import { randomUUID } from "node:crypto";
import type { Err } from "../types.js";

export const OFFERS_ROUTE = "/v1/products/{asin}/offers" as const;

export type OffersOutcome = Err;

export type GetOffersInput = {
  asin?: string;
  requestId?: string;
};

const NOT_IMPLEMENTED_MESSAGE =
  "Buy-box and other-seller offers are not implemented until the adapter is stable.";

export function getOffers(input: GetOffersInput = {}): OffersOutcome {
  return {
    error: {
      code: "not_implemented",
      message: NOT_IMPLEMENTED_MESSAGE,
      retryable: false,
    },
    meta: {
      creditsCharged: 0,
      requestId: input.requestId ?? `req_${randomUUID()}`,
    },
  };
}
