import type { LiveEvent } from "./live.js";

/** Display category for a feed item (used for filtering and grouping). */
export type LiveFeedItemKind = "activity" | "run_status" | "agent_status" | "run_summary";

/** Single entry in the live feed; wraps LiveEvent with a display kind and optional runId for grouping. */
export interface LiveFeedItem {
  kind: LiveFeedItemKind;
  event: LiveEvent;
  runId?: string;
}

/** Filter applied in the Live Feed strip UI. */
export const LIVE_FEED_FILTERS = ["all", "activity", "runs", "agents"] as const;
export type LiveFeedFilter = (typeof LIVE_FEED_FILTERS)[number];
