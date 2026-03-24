export const WIZARD_STEPS = [1, 2, 3, 4] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

export type WizardState = {
  step: WizardStep;
  /** Highest step the user has reached this session (for tab navigation). */
  maxStepReached: WizardStep;
  loading: boolean;
  error: string | null;
  company: {
    id: string | null;
    name: string;
    goalText: string;
    prefix: string | null;
  };
  worker: {
    skipped: boolean;
    enrollmentToken: string | null;
    enrollmentExpiresAt: string | null;
  };
  coo: {
    id: string | null;
    urlKey: string | null;
    name: string;
    timeoutMs: number;
    /** Maps to managed_worker adapter `promptTemplate` */
    focusText: string;
  };
};

export type WizardAction =
  | { type: "RESET"; payload: { initialStep: WizardStep; existingCompanyId: string | null } }
  | { type: "SET_STEP"; step: WizardStep }
  | { type: "SET_LOADING"; loading: boolean }
  | { type: "SET_ERROR"; error: string | null }
  | { type: "UPDATE_COMPANY"; patch: Partial<WizardState["company"]> }
  | { type: "UPDATE_WORKER"; patch: Partial<WizardState["worker"]> }
  | { type: "UPDATE_COO"; patch: Partial<WizardState["coo"]> };
