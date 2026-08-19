import type { ProductAdapter } from "../adapters/types.js";
import type { Key } from "../billing/keys.js";
import type { AsinApiDb } from "../db.js";

declare module "fastify" {
  interface FastifyInstance {
    db: AsinApiDb;
    adapter: ProductAdapter;
  }

  interface FastifyRequest {
    apiKey?: Key;
  }
}

export {};
