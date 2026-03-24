import type { CompanyStatus } from "../constants.js";

export interface Company {
  id: string;
  name: string;
  description: string | null;
  /** Free text prepended into production agent run prompts (with project/dept sections). */
  productionPolicies: string | null;
  status: CompanyStatus;
  issuePrefix: string;
  issueCounter: number;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
  requireBoardApprovalForNewAgents: boolean;
  requireQualityReviewForDone: boolean;
  brandColor: string | null;
  createdAt: Date;
  updatedAt: Date;
}
