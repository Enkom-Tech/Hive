import { z } from "zod";

/** Declared capabilities the host may grant before RPC or tool registration succeeds. */
export const PLUGIN_CAPABILITY_VALUES = ["rpc.ping", "events.subscribe", "tools.register"] as const;
export type PluginCapability = (typeof PLUGIN_CAPABILITY_VALUES)[number];

export const pluginCapabilitySchema = z.enum(PLUGIN_CAPABILITY_VALUES);

export const pluginManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  capabilities: z.array(pluginCapabilitySchema).default([]),
  tools: z
    .array(
      z.object({
        name: z.string().min(1),
        description: z.string().optional(),
      }),
    )
    .optional(),
});

export type PluginManifest = z.infer<typeof pluginManifestSchema>;

export function parsePluginManifestJson(json: string): PluginManifest {
  const raw: unknown = JSON.parse(json);
  return pluginManifestSchema.parse(raw);
}

export function safeParsePluginManifestJson(json: string) {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return pluginManifestSchema.safeParse(undefined);
  }
  return pluginManifestSchema.safeParse(raw);
}
