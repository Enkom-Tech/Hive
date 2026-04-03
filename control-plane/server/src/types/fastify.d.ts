import type { Principal } from "@hive/shared";

declare module "fastify" {
  interface FastifyRequest {
    principal?: Principal | null;
  }

  interface FastifyReply {
    locals: Record<string, unknown>;
  }
}
