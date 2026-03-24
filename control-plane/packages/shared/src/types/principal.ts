/**
 * Canonical principal shape for all auth providers (built-in, Logto, etc.).
 * Business logic should depend only on this type; IdP swap is a resolver change.
 */
export type PrincipalKind = "user" | "agent" | "system";

export interface Principal {
  type: PrincipalKind;
  id: string;
  /** Single company for agents. */
  company_id?: string;
  /** Company memberships for users. */
  company_ids?: string[];
  roles: string[];
  /** Permission keys in context (optional; can be resolved per-request). */
  scopes?: string[];
  /** Run id for audit (agents). */
  runId?: string;
  /** Agent key id for audit (agents). */
  keyId?: string;
}
