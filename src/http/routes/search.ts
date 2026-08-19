import type { FastifyPluginAsync } from "fastify";
import { searchProducts } from "../../core/search.js";
import { requireAuth } from "../auth.js";
import { sendErr, sendOk } from "../envelope.js";

export const SEARCH_PATH = "/v1/search" as const;

type SearchQuery = {
  q?: string;
  page?: string;
  fields?: string;
};

export const searchRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: SearchQuery }>(
    SEARCH_PATH,
    { preHandler: requireAuth },
    async (request, reply) => {
      const key = request.apiKey;
      if (key === undefined) {
        return sendErr(reply, "internal", "Authenticated route missing key.");
      }
      const result = await searchProducts({
        db: request.server.db,
        adapter: request.server.adapter,
        key,
        q: request.query.q,
        page: request.query.page,
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
