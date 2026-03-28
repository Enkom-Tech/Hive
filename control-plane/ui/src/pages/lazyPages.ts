import { lazy } from "react";

export const Dashboard = lazy(() => import("./Dashboard").then((m) => ({ default: m.Dashboard })));
export const Companies = lazy(() => import("./Companies").then((m) => ({ default: m.Companies })));
export const CompanySettings = lazy(() => import("./CompanySettings").then((m) => ({ default: m.CompanySettings })));
export const Departments = lazy(() => import("./Departments").then((m) => ({ default: m.Departments })));
export const Workers = lazy(() => import("./Workers").then((m) => ({ default: m.Workers })));
export const OrgChart = lazy(() => import("./OrgChart").then((m) => ({ default: m.OrgChart })));
export const Agents = lazy(() => import("./Agents").then((m) => ({ default: m.Agents })));
export const NewAgent = lazy(() => import("./NewAgent").then((m) => ({ default: m.NewAgent })));
export const AgentDetail = lazy(() => import("./AgentDetail").then((m) => ({ default: m.AgentDetail })));
export const Projects = lazy(() => import("./Projects").then((m) => ({ default: m.Projects })));
export const ProjectDetail = lazy(() => import("./ProjectDetail").then((m) => ({ default: m.ProjectDetail })));
export const Issues = lazy(() => import("./Issues").then((m) => ({ default: m.Issues })));
export const IssueDetail = lazy(() => import("./IssueDetail").then((m) => ({ default: m.IssueDetail })));
export const Goals = lazy(() => import("./Goals").then((m) => ({ default: m.Goals })));
export const GoalDetail = lazy(() => import("./GoalDetail").then((m) => ({ default: m.GoalDetail })));
export const Approvals = lazy(() => import("./Approvals").then((m) => ({ default: m.Approvals })));
export const ApprovalDetail = lazy(() => import("./ApprovalDetail").then((m) => ({ default: m.ApprovalDetail })));
export const Costs = lazy(() => import("./Costs").then((m) => ({ default: m.Costs })));
export const Standup = lazy(() => import("./Standup").then((m) => ({ default: m.Standup })));
export const Activity = lazy(() => import("./Activity").then((m) => ({ default: m.Activity })));
export const Inbox = lazy(() => import("./Inbox").then((m) => ({ default: m.Inbox })));
export const DesignGuide = lazy(() => import("./DesignGuide").then((m) => ({ default: m.DesignGuide })));
export const RunTranscriptUxLab = lazy(() =>
  import("./RunTranscriptUxLab").then((m) => ({ default: m.RunTranscriptUxLab })),
);
export const InstanceStatus = lazy(() => import("./InstanceStatus").then((m) => ({ default: m.InstanceStatus })));
export const InstanceSettings = lazy(() => import("./InstanceSettings").then((m) => ({ default: m.InstanceSettings })));
