import { z } from "zod";

const profileKeyRegex = /^[a-z][a-z0-9_-]{0,62}$/;

export const createWorkerIdentitySlotSchema = z.object({
  profileKey: z
    .string()
    .min(1)
    .max(64)
    .regex(profileKeyRegex, "profileKey must be lowercase slug (a-z0-9_-), max 64 chars"),
  displayNamePrefix: z.string().min(1).max(120),
  desiredCount: z.number().int().min(0).max(500),
  workerPlacementMode: z.enum(["manual", "automatic"]).optional(),
  operationalPosture: z.enum(["active", "archived", "hibernate", "sandbox"]).optional(),
  adapterType: z.literal("managed_worker").optional(),
  adapterConfig: z.record(z.string(), z.unknown()).optional(),
  runtimeConfig: z.record(z.string(), z.unknown()).optional(),
  role: z.string().min(1).max(64).optional(),
  enabled: z.boolean().optional(),
});

export type CreateWorkerIdentitySlot = z.infer<typeof createWorkerIdentitySlotSchema>;

export const patchWorkerIdentitySlotSchema = z.object({
  displayNamePrefix: z.string().min(1).max(120).optional(),
  desiredCount: z.number().int().min(0).max(500).optional(),
  workerPlacementMode: z.enum(["manual", "automatic"]).optional(),
  operationalPosture: z.enum(["active", "archived", "hibernate", "sandbox"]).optional(),
  adapterConfig: z.record(z.string(), z.unknown()).optional(),
  runtimeConfig: z.record(z.string(), z.unknown()).optional(),
  role: z.string().min(1).max(64).optional(),
  enabled: z.boolean().optional(),
});

export type PatchWorkerIdentitySlot = z.infer<typeof patchWorkerIdentitySlotSchema>;

export const droneAutoDeployProfileQuerySchema = z.object({
  target: z.enum(["docker", "k3s"]).default("docker"),
});

export type DroneAutoDeployProfileQuery = z.infer<typeof droneAutoDeployProfileQuerySchema>;
