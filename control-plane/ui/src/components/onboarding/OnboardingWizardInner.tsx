import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useDialog } from "../../context/DialogContext";
import { useCompany } from "../../context/CompanyContext";
import { queryKeys } from "../../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AsciiArtAnimation } from "../AsciiArtAnimation";
import { Building2, Bot, ArrowLeft, ArrowRight, Loader2, X, Rocket, Radio } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { WizardStep } from "./wizardTypes";
import {
  wizardReducer,
  initialWizardState,
  canGoToStep,
  getStepDisabledReason,
} from "./wizardReducer";
import { createCompanyWithGoal, ensureCooAgent, updateCooFromOnboarding } from "./onboardingApi";
import { CompanyStep } from "./steps/CompanyStep";
import { WorkerStep } from "./steps/WorkerStep";
import { CooStep } from "./steps/CooStep";
import { FinishStep } from "./steps/FinishStep";
import { useAgentWorkerStatus } from "../../hooks/useAgentWorkerStatus";
import type { Agent } from "@hive/shared";

function promptTemplateFromAgent(agent: Agent): string {
  const raw = agent.adapterConfig?.promptTemplate;
  return typeof raw === "string" ? raw : "";
}

export function OnboardingWizardInner() {
  const { onboardingOpen, onboardingOptions, closeOnboarding } = useDialog();
  const { companies, setSelectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const minStepForBack = (onboardingOptions.initialStep ?? 1) as WizardStep;

  const [state, dispatch] = useReducer(
    wizardReducer,
    onboardingOptions,
    (opts) =>
      initialWizardState({
        initialStep: (opts.initialStep ?? 1) as WizardStep,
        existingCompanyId: opts.companyId ?? null,
      }),
  );

  const [cooEnsurePending, setCooEnsurePending] = useState(false);
  const ensureRunRef = useRef(0);

  useLayoutEffect(() => {
    if (!onboardingOpen) return;
    dispatch({
      type: "RESET",
      payload: {
        initialStep: (onboardingOptions.initialStep ?? 1) as WizardStep,
        existingCompanyId: onboardingOptions.companyId ?? null,
      },
    });
    ensureRunRef.current += 1;
  }, [onboardingOpen, onboardingOptions.companyId, onboardingOptions.initialStep]);

  useEffect(() => {
    if (!onboardingOpen || !state.company.id || state.company.prefix) return;
    const company = companies.find((c) => c.id === state.company.id);
    if (company) {
      dispatch({
        type: "UPDATE_COMPANY",
        patch: { prefix: company.issuePrefix, name: state.company.name || company.name },
      });
    }
  }, [onboardingOpen, state.company.id, state.company.prefix, state.company.name, companies]);

  useEffect(() => {
    if (!onboardingOpen || !state.company.id || state.company.name) return;
    const company = companies.find((c) => c.id === state.company.id);
    if (company) {
      dispatch({ type: "UPDATE_COMPANY", patch: { name: company.name, prefix: company.issuePrefix } });
    }
  }, [onboardingOpen, state.company.id, state.company.name, companies]);

  // Pre-fill COO name with "{Company} COO" when company name is available
  useEffect(() => {
    if (!onboardingOpen || !state.company.name || state.coo.name !== "COO") return;
    const suggestedName = `${state.company.name} COO`;
    dispatch({ type: "UPDATE_COO", patch: { name: suggestedName } });
  }, [onboardingOpen, state.company.name, state.coo.name]);

  useEffect(() => {
    if (!onboardingOpen || state.step !== 2 || !state.company.id || state.coo.id) return;

    const runId = ++ensureRunRef.current;
    let cancelled = false;

    setCooEnsurePending(true);
    dispatch({ type: "SET_ERROR", error: null });

    void (async () => {
      try {
        const agent = await ensureCooAgent(queryClient, state.company.id!, state.company.goalText);
        if (cancelled || runId !== ensureRunRef.current) return;
        const pt = promptTemplateFromAgent(agent);
        const rawT = (agent.adapterConfig as Record<string, unknown>)?.timeoutMs;
        const timeoutMs =
          typeof rawT === "number" && Number.isFinite(rawT) && rawT >= 1000 && rawT <= 300000
            ? rawT
            : 15000;
        dispatch({
          type: "UPDATE_COO",
          patch: {
            id: agent.id,
            urlKey: agent.urlKey,
            name: agent.name,
            focusText: pt,
            timeoutMs,
          },
        });
      } catch (err) {
        if (cancelled || runId !== ensureRunRef.current) return;
        dispatch({
          type: "SET_ERROR",
          error: err instanceof Error ? err.message : "Could not prepare COO agent",
        });
      } finally {
        if (!cancelled && runId === ensureRunRef.current) {
          setCooEnsurePending(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [onboardingOpen, state.step, state.company.id, state.company.goalText, state.coo.id, queryClient]);

  const { data: workerConn } = useAgentWorkerStatus(state.coo.id, state.company.id, {
    enabled: Boolean(onboardingOpen && state.coo.id && state.company.id && !state.worker.skipped),
    pollWhileDisconnected: true,
  });
  const workerConnected = workerConn?.connected === true;

  const resetAndClose = useCallback(() => {
    dispatch({
      type: "RESET",
      payload: { initialStep: 1, existingCompanyId: null },
    });
    closeOnboarding();
  }, [closeOnboarding]);

  const handleClose = useCallback(() => {
    resetAndClose();
  }, [resetAndClose]);

  const goCompanyNext = useCallback(async () => {
    if (state.company.id) {
      dispatch({ type: "SET_STEP", step: 2 });
      return;
    }
    const nameErr = !state.company.name.trim() ? "Enter a company name." : null;
    if (nameErr) {
      dispatch({ type: "SET_ERROR", error: nameErr });
      return;
    }
    dispatch({ type: "SET_LOADING", loading: true });
    dispatch({ type: "SET_ERROR", error: null });
    try {
      const { id, issuePrefix } = await createCompanyWithGoal(
        queryClient,
        state.company.name,
        state.company.goalText,
        setSelectedCompanyId,
      );
      dispatch({
        type: "UPDATE_COMPANY",
        patch: { id, prefix: issuePrefix },
      });
      dispatch({ type: "SET_STEP", step: 2 });
    } catch (err) {
      dispatch({
        type: "SET_ERROR",
        error: err instanceof Error ? err.message : "Failed to create company",
      });
    } finally {
      dispatch({ type: "SET_LOADING", loading: false });
    }
  }, [
    queryClient,
    setSelectedCompanyId,
    state.company.goalText,
    state.company.id,
    state.company.name,
  ]);

  const goWorkerNext = useCallback(() => {
    dispatch({ type: "SET_STEP", step: 3 });
  }, []);

  const goWorkerSkip = useCallback(() => {
    dispatch({ type: "UPDATE_WORKER", patch: { skipped: true } });
    dispatch({ type: "SET_STEP", step: 3 });
  }, []);

  const goCooNext = useCallback(async () => {
    if (!state.company.id || !state.coo.id) return;
    if (!state.coo.name.trim()) {
      dispatch({ type: "SET_ERROR", error: "Enter a name for your COO agent." });
      return;
    }
    dispatch({ type: "SET_LOADING", loading: true });
    dispatch({ type: "SET_ERROR", error: null });
    try {
      const updated = await updateCooFromOnboarding(queryClient, state.company.id, state.coo.id, {
        name: state.coo.name,
        focusText: state.coo.focusText,
        timeoutMs: state.coo.timeoutMs,
      });
      dispatch({
        type: "UPDATE_COO",
        patch: {
          name: updated.name,
          urlKey: updated.urlKey,
          focusText: promptTemplateFromAgent(updated),
        },
      });
      dispatch({ type: "SET_STEP", step: 4 });
    } catch (err) {
      dispatch({
        type: "SET_ERROR",
        error: err instanceof Error ? err.message : "Failed to update COO",
      });
    } finally {
      dispatch({ type: "SET_LOADING", loading: false });
    }
  }, [
    queryClient,
    state.company.id,
    state.coo.focusText,
    state.coo.id,
    state.coo.name,
    state.coo.timeoutMs,
  ]);

  const handleLaunch = useCallback(() => {
    const prefix = state.company.prefix;
    const urlKey = state.coo.urlKey;
    const hasCoo = Boolean(state.coo.id && urlKey);
    resetAndClose();
    if (prefix && hasCoo) {
      navigate(`/${prefix}/agents/${encodeURIComponent(urlKey!)}`);
      return;
    }
    if (prefix) {
      navigate(`/${prefix}/dashboard`);
      return;
    }
    navigate("/dashboard");
  }, [navigate, resetAndClose, state.company.prefix, state.coo.id, state.coo.urlKey]);

  const submitPrimaryAction = useCallback(() => {
    if (state.loading || cooEnsurePending) return;
    switch (state.step) {
      case 1:
        void goCompanyNext();
        break;
      case 2:
        goWorkerNext();
        break;
      case 3:
        void goCooNext();
        break;
      case 4:
        handleLaunch();
        break;
      default:
        break;
    }
  }, [
    cooEnsurePending,
    goCompanyNext,
    goCooNext,
    goWorkerNext,
    handleLaunch,
    state.loading,
    state.step,
  ]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submitPrimaryAction();
      }
    },
    [submitPrimaryAction],
  );

  const setEnrollmentResult = useCallback((token: string | null, expiresAt: string | null) => {
    dispatch({
      type: "UPDATE_WORKER",
      patch: { enrollmentToken: token, enrollmentExpiresAt: expiresAt },
    });
  }, []);

  const launchLabel =
    state.coo.id && workerConnected
      ? "Open COO overview"
      : state.coo.id
        ? "Open dashboard — finish worker setup"
        : "Open dashboard";

  const stepTabs = [
    { step: 1 as const, label: "Company", icon: Building2 },
    { step: 2 as const, label: "Worker", icon: Radio },
    { step: 3 as const, label: "COO", icon: Bot },
    { step: 4 as const, label: "Finish", icon: Rocket },
  ];

  return (
    <TooltipProvider delayDuration={300}>
      <div className="fixed inset-0 z-50 bg-background" />
      <div className="fixed inset-0 z-50 flex" onKeyDown={handleKeyDown}>
        <button
          type="button"
          onClick={handleClose}
          className="absolute top-4 left-4 z-10 rounded-sm p-1.5 text-muted-foreground/60 hover:text-foreground transition-colors cursor-pointer"
        >
          <X className="h-5 w-5" />
          <span className="sr-only">Close</span>
        </button>

        <div
          className={cn(
            "w-full flex flex-col overflow-y-auto transition-[width] duration-500 ease-in-out",
            state.step === 1 ? "md:w-1/2" : "md:w-full",
          )}
        >
          <div className="w-full max-w-md mx-auto my-auto px-8 py-12 shrink-0">
            <div className="flex items-center gap-0 mb-8 border-b border-border">
              {stepTabs.map(({ step: s, label, icon: Icon }) => {
                const disabled = !canGoToStep(state, s);
                const reason = getStepDisabledReason(state, s);
                const tabBtn = (
                  <button
                    key={s}
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      if (!disabled) dispatch({ type: "SET_STEP", step: s });
                    }}
                    className={cn(
                      "flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 -mb-px transition-colors",
                      s === state.step
                        ? "border-foreground text-foreground"
                        : "border-transparent text-muted-foreground",
                      disabled
                        ? "opacity-40 cursor-not-allowed"
                        : "hover:text-foreground/70 hover:border-border cursor-pointer",
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {label}
                  </button>
                );
                if (disabled && reason) {
                  return (
                    <Tooltip key={s}>
                      <TooltipTrigger asChild>
                        <span className="inline-flex">{tabBtn}</span>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">{reason}</TooltipContent>
                    </Tooltip>
                  );
                }
                return tabBtn;
              })}
            </div>

            {state.step === 1 && (
              <CompanyStep
                companyName={state.company.name}
                goalText={state.company.goalText}
                onCompanyNameChange={(name) => dispatch({ type: "UPDATE_COMPANY", patch: { name } })}
                onGoalTextChange={(goalText) => dispatch({ type: "UPDATE_COMPANY", patch: { goalText } })}
                companyAlreadyCreated={Boolean(state.company.id)}
              />
            )}

            {state.step === 2 && state.company.id && (
              <WorkerStep
                companyId={state.company.id}
                agentId={state.coo.id}
                ensuringAgent={cooEnsurePending}
                ensureError={
                  state.step === 2 && !cooEnsurePending && !state.coo.id && state.error ? state.error : null
                }
                enrollmentToken={state.worker.enrollmentToken}
                enrollmentExpiresAt={state.worker.enrollmentExpiresAt}
                onEnrollmentResult={setEnrollmentResult}
                workerSkipped={state.worker.skipped}
              />
            )}

            {state.step === 3 && (
              <CooStep
                name={state.coo.name}
                focusText={state.coo.focusText}
                onNameChange={(name) => dispatch({ type: "UPDATE_COO", patch: { name } })}
                onFocusChange={(focusText) => dispatch({ type: "UPDATE_COO", patch: { focusText } })}
              />
            )}

            {state.step === 4 && (
              <FinishStep
                companyName={state.company.name}
                missionSummary={state.company.goalText.trim()}
                workerConnected={workerConnected}
                workerSkipped={state.worker.skipped}
                cooName={state.coo.name}
                cooConfigured={Boolean(state.coo.id)}
              />
            )}

            {state.error && state.step !== 2 && (
              <div className="mt-3">
                <p className="text-xs text-destructive">{state.error}</p>
              </div>
            )}

            <div className="flex items-center justify-between mt-8">
              <div>
                {state.step > minStepForBack && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      dispatch({ type: "SET_ERROR", error: null });
                      dispatch({ type: "SET_STEP", step: (state.step - 1) as WizardStep });
                    }}
                    disabled={state.loading || cooEnsurePending}
                  >
                    <ArrowLeft className="h-3.5 w-3.5 mr-1" />
                    Back
                  </Button>
                )}
              </div>
              <div className="flex items-center gap-2">
                {state.step === 1 && (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={state.loading}
                      onClick={() => {
                        // Skip onboarding and go to dashboard
                        resetAndClose();
                        navigate("/dashboard");
                      }}
                    >
                      Set up later
                    </Button>
                    <Button
                      size="sm"
                      disabled={!state.company.id && (!state.company.name.trim() || state.loading)}
                      onClick={() => void goCompanyNext()}
                    >
                      {state.loading && !state.company.id ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      ) : (
                        <ArrowRight className="h-3.5 w-3.5 mr-1" />
                      )}
                      {state.loading && !state.company.id ? "Creating…" : "Continue"}
                    </Button>
                  </>
                )}
                {state.step === 2 && (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={state.loading || cooEnsurePending || !state.coo.id}
                      onClick={goWorkerSkip}
                    >
                      Skip for now
                    </Button>
                    <Button
                      size="sm"
                      disabled={state.loading || cooEnsurePending || !state.coo.id || Boolean(state.error)}
                      onClick={goWorkerNext}
                    >
                      <ArrowRight className="h-3.5 w-3.5 mr-1" />
                      Continue
                    </Button>
                  </>
                )}
                {state.step === 3 && (
                  <Button
                    size="sm"
                    disabled={!state.coo.name.trim() || state.loading}
                    onClick={() => void goCooNext()}
                  >
                    {state.loading ? (
                      <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                    ) : (
                      <ArrowRight className="h-3.5 w-3.5 mr-1" />
                    )}
                    {state.loading ? "Saving…" : "Continue"}
                  </Button>
                )}
                {state.step === 4 && (
                  <Button size="sm" disabled={state.loading} onClick={handleLaunch}>
                    <ArrowRight className="h-3.5 w-3.5 mr-1" />
                    {launchLabel}
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>

        <div
          className={cn(
            "hidden md:block overflow-hidden bg-[#1d1d1d] transition-[width,opacity] duration-500 ease-in-out",
            state.step === 1 ? "w-1/2 opacity-100" : "w-0 opacity-0",
          )}
        >
          <AsciiArtAnimation />
        </div>
      </div>
    </TooltipProvider>
  );
}
