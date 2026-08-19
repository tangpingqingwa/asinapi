import type { Key } from "../billing/keys.js";
import type { AsinApiDb } from "../db.js";

declare module "fastify" {
  interface FastifyInstance {
    db: AsinApiDb;
  }

  interface FastifyRequest {
    apiKey?: Key;
  }
}

export {};
