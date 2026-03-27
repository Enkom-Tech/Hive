import { z } from "zod";

export const createInferenceModelSchema = z.object({
  modelSlug: z.string().min(1),
  kind: z.enum(["chat", "embed"]).default("chat"),
  baseUrl: z.string().min(1),
  enabled: z.boolean().default(true),
  /** When true, row applies to the whole deployment (company_id NULL). Same board access as the company route. */
  deploymentDefault: z.boolean().optional().default(false),
});

export type CreateInferenceModel = z.infer<typeof createInferenceModelSchema>;

export const createGatewayVirtualKeySchema = z.object({
  label: z.string().max(256).optional().nullable(),
});

export type CreateGatewayVirtualKey = z.infer<typeof createGatewayVirtualKeySchema>;
