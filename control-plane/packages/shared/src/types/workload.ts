export type WorkloadRecommendationAction = "normal" | "throttle" | "shed" | "pause";

export interface WorkloadRecommendation {
  action: WorkloadRecommendationAction;
  reason: string;
  details: string[];
  submit_ok: boolean;
  suggested_delay_ms: number;
}

export interface WorkloadCapacityMetrics {
  active_issues: number;
  active_runs: number;
  runs_last_window: number;
  errors_last_window: number;
  error_rate: number;
}

export interface WorkloadQueueMetrics {
  total_pending: number;
  by_status: Record<string, number>;
  by_priority: Record<string, number>;
  oldest_pending_age_seconds: number | null;
  estimated_wait_seconds: number | null;
  estimated_wait_confidence: "calculated" | "unknown";
}

export interface WorkloadAgentMetrics {
  total: number;
  online: number;
  busy: number;
  idle: number;
  busy_ratio: number;
}

export interface WorkloadThresholds {
  queue_depth_normal: number;
  queue_depth_throttle: number;
  queue_depth_shed: number;
  busy_ratio_throttle: number;
  busy_ratio_shed: number;
  error_rate_throttle: number;
  error_rate_shed: number;
  recent_window_seconds: number;
  error_rate_enabled: boolean;
}

export interface WorkloadResponse {
  timestamp: number;
  companyId: string;
  capacity: WorkloadCapacityMetrics;
  queue: WorkloadQueueMetrics;
  agents: WorkloadAgentMetrics;
  recommendation: WorkloadRecommendation;
  thresholds: WorkloadThresholds;
}
