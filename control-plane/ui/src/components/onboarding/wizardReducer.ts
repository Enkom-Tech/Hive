import type { WizardAction, WizardState, WizardStep } from "./wizardTypes";

export function initialWizardState(payload: {
  initialStep: WizardStep;
  existingCompanyId: string | null;
}): WizardState {
  return {
    step: payload.initialStep,
    maxStepReached: payload.initialStep,
    loading: false,
    error: null,
    company: {
      id: payload.existingCompanyId,
      name: "",
      goalText: "",
      prefix: null,
    },
    worker: {
      skipped: false,
      enrollmentToken: null,
      enrollmentExpiresAt: null,
    },
    coo: {
      id: null,
      urlKey: null,
      name: "COO",
      timeoutMs: 15000,
      focusText: "",
    },
  };
}

export function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case "RESET":
      return initialWizardState(action.payload);
    case "SET_STEP":
      return {
        ...state,
        step: action.step,
        maxStepReached: Math.max(state.maxStepReached, action.step) as WizardStep,
      };
    case "SET_LOADING":
      return { ...state, loading: action.loading };
    case "SET_ERROR":
      return { ...state, error: action.error };
    case "UPDATE_COMPANY":
      return { ...state, company: { ...state.company, ...action.patch } };
    case "UPDATE_WORKER":
      return { ...state, worker: { ...state.worker, ...action.patch } };
    case "UPDATE_COO":
      return { ...state, coo: { ...state.coo, ...action.patch } };
    default:
      return state;
  }
}

export function canGoToStep(state: WizardState, target: WizardStep): boolean {
  return getStepDisabledReason(state, target) === null;
}

export function getStepDisabledReason(state: WizardState, target: WizardStep): string | null {
  if (target === 1) return null;
  if (!state.company.id) {
    return "Create your company first.";
  }
  if (target === 2) return null;
  if (!state.coo.id) {
    return "Finish the worker step first.";
  }
  if (target === 3) return null;
  if (target === 4 && state.maxStepReached < 4) {
    return "Complete the COO step first.";
  }
  if (target === 4) return null;
  return null;
}
