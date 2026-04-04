/// <reference path="../types/fastify.d.ts" />
import type { FastifyRequest } from "fastify";
import type { Principal } from "@hive/shared";

/**
 * Fastify-native principal resolver.
 */
export type FastifyPrincipalResolver = (req: FastifyRequest) => Promise<Principal | null>;

/**
 * Alias kept for any code that still references PrincipalResolver during cleanup.
 * @deprecated Use FastifyPrincipalResolver.
 */
export type PrincipalResolver = FastifyPrincipalResolver;

