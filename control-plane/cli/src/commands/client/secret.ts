import { Command } from "commander";
import { SECRET_PROVIDERS, type SecretProvider } from "@hive/shared";
import {
  addCommonClientOptions,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface SecretMigrateOptions extends BaseClientOptions {
  targetProvider: SecretProvider;
  dryRun?: boolean;
  apply?: boolean;
  secretIds?: string;
}

function parseSecretIds(raw: string | undefined): string[] | undefined {
  if (!raw || raw.trim().length === 0) return undefined;
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export function registerSecretCommands(program: Command): void {
  const secret = program.command("secret").description("Secret operations");

  addCommonClientOptions(
    secret
      .command("migrate-provider")
      .description("Migrate company secrets from one provider to another")
      .requiredOption("--target-provider <provider>", "Target provider ID")
      .option("--dry-run", "Preview migration without applying", true)
      .option("--apply", "Apply migration changes")
      .option("--secret-ids <csv>", "Optional comma-separated secret IDs")
      .action(async (opts: SecretMigrateOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          if (!SECRET_PROVIDERS.includes(opts.targetProvider)) {
            throw new Error(
              `Invalid --target-provider value '${opts.targetProvider}'. Allowed: ${SECRET_PROVIDERS.join(", ")}`,
            );
          }
          const dryRun = opts.apply ? false : opts.dryRun !== false;
          const result = await ctx.api.post(
            `/api/companies/${ctx.companyId}/secrets/migrate-provider`,
            {
              targetProvider: opts.targetProvider,
              dryRun,
              secretIds: parseSecretIds(opts.secretIds),
            },
          );
          printOutput(result, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );
}
