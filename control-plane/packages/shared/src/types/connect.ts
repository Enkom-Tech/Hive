import type { Issue } from "./issue.js";

export interface ConnectResponse {
  agentId: string;
  heartbeatUrl: string;
  sseUrl: string;
  workItems?: WorkItemsResponse;
  apiKey?: string;
}

export interface WorkItemsResponse {
  tasks: Issue[];
}
