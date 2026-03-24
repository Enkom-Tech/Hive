export interface WebhookDelivery {
  id: string;
  companyId: string;
  agentId: string;
  issueId: string;
  eventType: string;
  status: string;
  httpStatusCode: number | null;
  responseBodyExcerpt: string | null;
  durationMs: number | null;
  attemptNumber: number;
  createdAt: string;
}
