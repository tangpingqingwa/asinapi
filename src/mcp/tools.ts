import type { ProductAdapter } from "../adapters/types.js";
import type { Key } from "../billing/keys.js";
import { getProduct, getProductByUrl, isRetryableCode } from "../core/product.js";
import { getReviews } from "../core/reviews.js";
import type { AsinApiDb } from "../db.js";
import type { Err, ErrorCode, Ok } from "../types.js";

export const GET_PRODUCT_TOOL = "get_product" as const;
export const LIST_REVIEWS_TOOL = "list_reviews" as const;

export const MCP_TOOL_NAMES = [GET_PRODUCT_TOOL, LIST_REVIEWS_TOOL] as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

export type McpToolDefinition = {
  name: McpToolName;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type McpToolOutcome = Ok<unknown> | Err;

export type CallMcpToolInput = {
  name: string;
  args: Record<string, unknown>;
  db: AsinApiDb;
  adapter: ProductAdapter;
  key: Key;
  requestId?: string;
};

export const MCP_TOOLS: readonly McpToolDefinition[] = [
  {
    name: GET_PRODUCT_TOOL,
    description:
      "Typed US Amazon product record. Maps to GET /v1/products/{asin} or " +
      "GET /v1/products/by-url. 1 credit on success, including cache hits. " +
      "Failures charge 0. US .com only. Prices can be 6h stale. " +
      "Not for checkout. Do not claim Keepa-like history.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        asin: {
          type: "string",
          description: "10-character Amazon ASIN (one of asin or url required)",
        },
        url: {
          type: "string",
          description:
            "amazon.com/dp/, /gp/product/, or already-resolved amzn.to (one of asin or url required)",
        },
      },
    },
  },
  {
    name: LIST_REVIEWS_TOOL,
    description:
      "One page of recorded US Amazon reviews. Maps to GET /v1/products/{asin}/reviews. " +
      "1 credit per page, including cache hits and empty pages. " +
      "Never invent a review. page is 1-based; sort is helpful or recent.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["asin"],
      properties: {
        asin: {
          type: "string",
          description: "10-character Amazon ASIN",
        },
        page: {
          type: "integer",
          minimum: 1,
          description: "1-based review page (default 1)",
        },
        sort: {
          type: "string",
          enum: ["helpful", "recent"],
          description: "helpful (default) or recent",
        },
      },
    },
  },
];

export function isMcpToolName(name: string): name is McpToolName {
  return (MCP_TOOL_NAMES as readonly string[]).includes(name);
}

/** Dispatch an MCP tool to core/* only. */
export async function callMcpTool(
  input: CallMcpToolInput,
): Promise<McpToolOutcome> {
  if (!isMcpToolName(input.name)) {
    return fail(
      "invalid_request",
      input.requestId,
      `Unknown MCP tool '${input.name}'.`,
    );
  }

  switch (input.name) {
    case GET_PRODUCT_TOOL:
      return dispatchGetProduct(input);
    case LIST_REVIEWS_TOOL:
      return getReviews({
        db: input.db,
        adapter: input.adapter,
        key: input.key,
        requestId: input.requestId,
        asin: readStringArg(input.args, "asin") ?? "",
        page: readPageArg(input.args, "page"),
        sort: readStringArg(input.args, "sort"),
      });
  }
}

async function dispatchGetProduct(
  input: CallMcpToolInput,
): Promise<McpToolOutcome> {
  const url = readStringArg(input.args, "url");
  const asin = readStringArg(input.args, "asin");
  if (url === undefined && asin === undefined) {
    return fail(
      "invalid_request",
      input.requestId,
      "Provide an asin or url argument.",
    );
  }
  if (url !== undefined) {
    return getProductByUrl({
      db: input.db,
      adapter: input.adapter,
      key: input.key,
      requestId: input.requestId,
      url,
    });
  }
  return getProduct({
    db: input.db,
    adapter: input.adapter,
    key: input.key,
    requestId: input.requestId,
    asin: asin ?? "",
  });
}

function fail(
  code: ErrorCode,
  requestId: string | undefined,
  message: string,
): Err {
  return {
    error: {
      code,
      message,
      retryable: isRetryableCode(code),
    },
    meta: { creditsCharged: 0, requestId: requestId ?? "req_mcp_unknown_tool" },
  };
}

function readStringArg(
  args: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string") {
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}

function readPageArg(
  args: Record<string, unknown>,
  key: string,
): string | number | undefined {
  const value = args[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    return value;
  }
  return undefined;
}
