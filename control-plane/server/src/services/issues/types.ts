export interface IssueFilters {
  status?: string;
  assigneeAgentId?: string;
  assigneeUserId?: string;
  departmentId?: string;
  touchedByUserId?: string;
  unreadForUserId?: string;
  projectId?: string;
  parentId?: string;
  labelId?: string;
  q?: string;
}
