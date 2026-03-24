import { z } from "zod";

const MAX_ENTITY_STRING_LENGTH = 256;

export const listActivityQuerySchema = z.object({
  agentId: z.string().uuid().optional(),
  entityType: z.string().max(MAX_ENTITY_STRING_LENGTH).optional(),
  entityId: z.string().max(MAX_ENTITY_STRING_LENGTH).optional(),
});

export type ListActivityQuery = z.infer<typeof listActivityQuerySchema>;
