export interface StandupIssueSummary {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  assigneeAgentId: string | null;
}

export interface StandupAgentSection {
  agentId: string;
  name: string;
  completed: StandupIssueSummary[];
  inProgress: StandupIssueSummary[];
  assigned: StandupIssueSummary[];
  review: StandupIssueSummary[];
  blocked: StandupIssueSummary[];
}

export interface StandupReport {
  companyId: string;
  generatedAt: string;
  agents: StandupAgentSection[];
  teamAccomplishments: StandupIssueSummary[];
  blockers: StandupIssueSummary[];
  overdue: StandupIssueSummary[];
}
