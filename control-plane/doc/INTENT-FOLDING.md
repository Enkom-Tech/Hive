# Deterministic Intent Folding

Deterministic intent folding is a control-plane feature that normalizes and folds user or agent requests into canonical intents in a deterministic and auditable way. Same input (text + structured context) yields the same canonical intent key and decision; repeated equivalent requests map to the same intent or are merged via links.

## Objective

- At specific ingress points (e.g. issue creation), normalize incoming requests into **canonical intents**.
- **Determinism:** Same input → same canonical key and decision. No randomness in the pipeline.
- **Idempotence:** Equivalent repeated requests fold into one intent (linked as duplicate/related) instead of creating duplicates.
- **Governance:** Explicit rules and stable hashes; no opaque LLM reasoning for the core folding decision. Optional semantic similarity (S4) uses fixed thresholds and deterministic embeddings if added later.

## Data model

### `intents`

| Column | Type | Notes |
|--------|------|--------|
| id | uuid | PK |
| company_id | uuid | FK companies, not null |
| source | text | `board` \| `agent` \| `api` |
| raw_text | text | Original request (e.g. title + description) |
| normalized_text | text | Canonical form after S1 |
| intent_type | text | e.g. `create_issue`, `update_goal`, `ops_action` |
| state | text | `open` \| `folded` \| `closed` \| `rejected` |
| canonical_key | text | Deterministic key for folding (hash) |
| created_at | timestamptz | |
| updated_at | timestamptz | |

**Invariants:**

- Every intent belongs to exactly one company. All lookups and inserts are company-scoped.
- Folding uses “existing open intent” semantics: when a request’s canonical key matches an existing intent in state `open` (same company), the request is folded (a link is created) rather than creating a new intent.
- Unique index on `(company_id, canonical_key)` supports fast lookup; folding logic only considers intents in state `open`.

### `intent_links`

| Column | Type | Notes |
|--------|------|--------|
| id | uuid | PK |
| intent_id | uuid | FK intents, not null |
| company_id | uuid | FK companies, not null (denormalized for fast scoped lookups) |
| entity_type | text | `issue` \| `goal` \| `project` \| `heartbeat_run` \| … |
| entity_id | text | Target entity id (uuid or string) |
| link_type | text | `primary` \| `duplicate` \| `related` |
| created_at | timestamptz | |

**Invariants:**

- Each link points to one intent; intent belongs to one company. Company scoping is preserved via intent_id (and denormalized company_id for indexing).
- Writes to intents and intent_links go through the **same transaction** as the related entity (e.g. issue creation). No intent or link is committed without the linked entity in the same transaction.

**Indexes:**

- `intent_links(intent_id)` — list links for an intent.
- `intent_links(company_id, entity_type, entity_id)` — find intent(s) for an entity (e.g. issue).

## Pipeline steps

The folding pipeline is implemented in the control plane as a pure, deterministic flow (with an optional bounded similarity step).

### S1: Canonicalization (fully deterministic)

- Lowercasing (locale-aware where specified).
- Strip whitespace, normalize line breaks, strip HTML if present.
- Stable tokenization (e.g. split on spaces and punctuation).
- Remove or normalize configurable noise tokens (e.g. common stop words).
- **No randomness; no model calls.**

### S2: Rule-based classification (deterministic)

- Map to `intent_type` from:
  - API route (e.g. issue create → `create_issue`),
  - Company config if needed,
  - Simple text patterns (optional).
- Hand-coded rules or small FSM. No LLM.

### S3: Canonical key computation (deterministic)

- Build a canonical string from: company id, intent type, normalized text (e.g. truncated, sorted tokens).
- Compute a stable hash (e.g. SHA-256) of that string. The result is `canonical_key`.
- Same inputs always produce the same key.

### S4: Optional model-assisted similarity (bounded, not source of determinism)

- If semantic folding is added later: generate embeddings (deterministic model, no sampling), compute cosine similarity to existing intents (same company and intent_type), apply documented similarity thresholds.
- Decisions are “similar enough → fold” vs “new intent” based on thresholds only. Not required for V1.

### S5: Decision and side effects

- **If** an open intent exists for the same company with the same `canonical_key`: create an `intent_link` (and optionally mark or count as folded); do not create a new intent row.
- **Else:** insert a new intent row (state `open`), then create the primary `intent_link`.
- All in the **same DB transaction** as the related entity (e.g. issue create). Use locking (e.g. unique index + serializable transaction or `SELECT ... FOR UPDATE`) to avoid races.
- Activity log and live events are emitted **after** commit (see Event bus below).

## Ingress points

### V1

- **POST /companies/:companyId/issues**  
  For each new issue creation, the handler runs a single transaction that: (1) runs `createOrFoldIntent(tx, input)` with raw text = title + description (and source, projectId, goalId), (2) creates the issue (using the same tx), (3) inserts an `intent_link` from the intent to the new issue with link_type `primary`. After commit, the route logs activity for both issue.created and intent.created or intent.folded_into_existing, and emits the corresponding live events.

### Future

- “Quick command” or natural-language endpoints: same pattern — normalize, createOrFoldIntent, link to the resulting entity.
- Heartbeat-triggered “same ask” aggregation is deferred; no change to the worker path initially.

## Event bus

Live events (in-process) are used for real-time updates. New event types:

- **intent.created** — A new intent was created. Payload: companyId, intentId, canonicalKey, linked entity (e.g. issueId), link_type.
- **intent.folded** — A request was folded into an existing intent. Payload: companyId, intentId, canonicalKey, folded entity (e.g. issueId), link_type (e.g. duplicate).
- **intent.closed** — An intent was closed/resolved (optional; when lifecycle is implemented). Payload: companyId, intentId, canonicalKey.

All payloads are company-scoped and must not include secrets or private fields. Emit after the transaction commits.

## Security and determinism

- **Determinism:** No randomness in the pipeline (no `Math.random`, no temperature/top-p). If S4 is used, embedding calls must use deterministic parameters.
- **Isolation:** Folding is **company-scoped**. Never fold across companies. All lookups and inserts filter by companyId.
- **Auditability:** Every create/fold produces an activity_log entry (e.g. `intent.created`, `intent.folded_into_existing`) with canonicalKey, intentId(s), linked entity id, and folded flag. These are queryable from admin/board UI.
- **Performance:** Unique/index on `(company_id, canonical_key)` for fast lookups. For future embedding similarity, restrict search to company and intent_type.
- **Governance:** Folding does not bypass approvals, budgets, or company isolation. Plugins (when present) may subscribe to intent events but must not override folding decisions or mutate canonical_key/state directly.

## Querying intents and links

- **By company:** List intents for a company (filter by state, intent_type, source as needed).
- **By entity:** Use `intent_links(company_id, entity_type, entity_id)` to find intent(s) linked to an issue, goal, project, or run.
- **By canonical key:** Look up intent by `(company_id, canonical_key)` to see if an open intent already exists for that key.

Implementation contract and table definitions are in [SPEC-implementation.md](SPEC-implementation.md) §7.15.
