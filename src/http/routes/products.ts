import type { FastifyPluginAsync } from "fastify";
import { getOffers } from "../../core/offers.js";
import { getProduct, getProductByUrl } from "../../core/product.js";
import { getReviews } from "../../core/reviews.js";
import { requireAuth } from "../auth.js";
import { sendErr, sendOk } from "../envelope.js";

export const PRODUCT_BY_ASIN_PATH = "/v1/products/:asin" as const;
export const PRODUCT_BY_URL_PATH = "/v1/products/by-url" as const;
export const PRODUCT_REVIEWS_PATH = "/v1/products/:asin/reviews" as const;
export const PRODUCT_OFFERS_PATH = "/v1/products/:asin/offers" as const;

type ByUrlQuery = {
  url?: string;
  fields?: string;
};

type AsinParams = {
  asin: string;
};

type ProductQuery = {
  fields?: string;
};

type ReviewsQuery = {
  page?: string;
  sort?: string;
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
        fields: request.query.fields,
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
    PRODUCT_OFFERS_PATH,
    { preHandler: requireAuth },
    async (request, reply) => {
      const result = getOffers({ asin: request.params.asin });
      return sendErr(
        reply,
        result.error.code,
        result.error.message,
        result.meta.requestId,
      );
    },
  );

  app.get<{ Params: AsinParams; Querystring: ReviewsQuery }>(
    PRODUCT_REVIEWS_PATH,
    { preHandler: requireAuth },
    async (request, reply) => {
      const key = request.apiKey;
      if (key === undefined) {
        return sendErr(reply, "internal", "Authenticated route missing key.");
      }
      const result = await getReviews({
        db: request.server.db,
        adapter: request.server.adapter,
        key,
        asin: request.params.asin,
        page: request.query.page,
        sort: request.query.sort,
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

  app.get<{ Params: AsinParams; Querystring: ProductQuery }>(
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
        fields: request.query.fields,
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
