import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db, DbTransaction } from "@hive/db";
import { intents, intentLinks } from "@hive/db";
import type { IntentSource, IntentType } from "@hive/shared";
import { INTENT_STATES } from "@hive/shared";

/** Max length of normalized text used for canonical key to avoid huge hashes. */
const CANONICAL_TEXT_TRUNCATE = 2000;

/** Default noise tokens to remove during canonicalization (configurable). */
const DEFAULT_NOISE_TOKENS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "must",
  "shall",
  "can",
  "need",
  "dare",
  "ought",
  "used",
]);

/**
 * S1: Canonicalization. Fully deterministic.
 * Lowercase, strip HTML, collapse whitespace, optional noise-token removal.
 */
export function canonicalize(
  raw: string,
  options?: { removeNoiseTokens?: boolean; noiseTokens?: Set<string> },
): string {
  if (raw === "") return "";
  const removeNoise = options?.removeNoiseTokens ?? false;
  const noise = options?.noiseTokens ?? DEFAULT_NOISE_TOKENS;

  let s = raw
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (s === "") return "";

  if (!removeNoise) return s;
  const tokens = s.split(/\s+/).filter((t) => t.length > 0 && !noise.has(t));
  return tokens.join(" ");
}

/**
 * S3: Canonical key computation. Deterministic.
 * Stable hash of companyId + intentType + normalized text (truncated).
 */
export function computeCanonicalKey(
  companyId: string,
  intentType: string,
  normalizedText: string,
): string {
  const truncated =
    normalizedText.length > CANONICAL_TEXT_TRUNCATE
      ? normalizedText.slice(0, CANONICAL_TEXT_TRUNCATE)
      : normalizedText;
  const payload = `${companyId}\n${intentType}\n${truncated}`;
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

export interface IntentInput {
  companyId: string;
  rawText: string;
  source: IntentSource;
  intentType: IntentType;
  projectId?: string | null;
  goalId?: string | null;
}

export interface IntentResult {
  intentId: string;
  folded: boolean;
  canonicalKey: string;
}

/**
 * S5: Create or fold intent. Runs inside caller's transaction.
 * Pass the transaction client (same interface as Db).
 * Returns intentId (existing or new), folded flag, and canonicalKey.
 * Caller must insert intent_link for the new entity (e.g. issue) after creating it.
 */
export async function createOrFoldIntent(
  tx: DbTransaction,
  input: IntentInput,
): Promise<IntentResult> {
  const normalizedText = canonicalize(input.rawText);
  const canonicalKey = computeCanonicalKey(
    input.companyId,
    input.intentType,
    normalizedText,
  );

  const openState = INTENT_STATES[0]; // "open"

  const existing = await tx
    .select({ id: intents.id })
    .from(intents)
    .where(
      and(
        eq(intents.companyId, input.companyId),
        eq(intents.canonicalKey, canonicalKey),
        eq(intents.state, openState),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (existing) {
    return {
      intentId: existing.id,
      folded: true,
      canonicalKey,
    };
  }

  const [inserted] = await tx
    .insert(intents)
    .values({
      companyId: input.companyId,
      source: input.source,
      rawText: input.rawText,
      normalizedText,
      intentType: input.intentType,
      state: openState,
      canonicalKey,
    })
    .returning({ id: intents.id });

  if (!inserted) {
    const retry = await tx
      .select({ id: intents.id })
      .from(intents)
      .where(
        and(
          eq(intents.companyId, input.companyId),
          eq(intents.canonicalKey, canonicalKey),
          eq(intents.state, openState),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (retry) {
      return { intentId: retry.id, folded: true, canonicalKey };
    }
    throw new Error("Intent insert failed and no existing intent found");
  }

  return {
    intentId: inserted.id,
    folded: false,
    canonicalKey,
  };
}

/**
 * Insert an intent_link row. Runs inside caller's transaction.
 */
export async function insertIntentLink(
  tx: DbTransaction,
  params: {
    intentId: string;
    companyId: string;
    entityType: string;
    entityId: string;
    linkType: "primary" | "duplicate" | "related";
  },
): Promise<void> {
  await tx.insert(intentLinks).values({
    intentId: params.intentId,
    companyId: params.companyId,
    entityType: params.entityType,
    entityId: params.entityId,
    linkType: params.linkType,
  });
}

/**
 * Intent folding service factory. Exposes createOrFoldIntent and insertIntentLink
 * for use with a transaction, plus pure helpers for tests.
 */
export function intentFoldingService(_db: Db) {
  return {
    canonicalize,
    computeCanonicalKey,
    createOrFoldIntent,
    insertIntentLink,
  };
}
