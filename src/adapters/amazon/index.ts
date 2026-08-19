import type { AdapterResult, ProductAdapter } from "../types.js";

/**
 * Live Amazon path is a later PR. This stub implements the adapter
 * contract without opening a network socket.
 */
export function createLiveAmazonAdapter(): ProductAdapter {
  return {
    resolveShortCode(): string | null {
      return null;
    },
    async fetchProduct(): Promise<AdapterResult> {
      return { ok: false, code: "upstream_blocked" };
    },
    async fetchReviews() {
      return { ok: false, code: "upstream_blocked" as const };
    },
  };
}
