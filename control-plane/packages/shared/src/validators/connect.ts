import { z } from "zod";

export const connectSchema = z.object({
  toolName: z.string().min(1),
  toolVersion: z.string().optional(),
  agentName: z.string().min(1),
});

export type ConnectRequest = z.infer<typeof connectSchema>;
