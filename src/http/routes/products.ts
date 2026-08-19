import type { FastifyPluginAsync } from "fastify";
import { getProduct, getProductByUrl } from "../../core/product.js";
import { requireAuth } from "../auth.js";
import { sendErr, sendOk } from "../envelope.js";

export const PRODUCT_BY_ASIN_PATH = "/v1/products/:asin" as const;
export const PRODUCT_BY_URL_PATH = "/v1/products/by-url" as const;

type ByUrlQuery = {
  url?: string;
};

type AsinParams = {
  asin: string;
};

export const productRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: ByUrlQuery }>(
    PRODUCT_BY_URL_PATH,
    { preHandler: requireAuth },
    async (request, reply) => {
      const key = request.apiKey;
      if (key === undefined) {
        return sendErr(reply, "internal", "Authenticated route missing key.");
      }
      const result = await getProductByUrl({
        db: request.server.db,
        adapter: request.server.adapter,
        key,
        url: request.query.url,
      });
      if ("error" in result) {
        return sendErr(
          reply,
          result.error.code,
          result.error.message,
          result.meta.requestId,
        );
      }
      return sendOk(reply, result.data, result.meta);
    },
  );

  app.get<{ Params: AsinParams }>(
    PRODUCT_BY_ASIN_PATH,
    { preHandler: requireAuth },
    async (request, reply) => {
      const key = request.apiKey;
      if (key === undefined) {
        return sendErr(reply, "internal", "Authenticated route missing key.");
      }
      const result = await getProduct({
        db: request.server.db,
        adapter: request.server.adapter,
        key,
        asin: request.params.asin,
      });
      if ("error" in result) {
        return sendErr(
          reply,
          result.error.code,
          result.error.message,
          result.meta.requestId,
        );
      }
      return sendOk(reply, result.data, result.meta);
    },
  );
};
