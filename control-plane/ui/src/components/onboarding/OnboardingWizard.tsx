import { useCallback } from "react";
import { useDialog } from "../../context/DialogContext";
import { Dialog, DialogPortal } from "@/components/ui/dialog";
import { OnboardingWizardInner } from "./OnboardingWizardInner";

export function OnboardingWizard() {
  const { onboardingOpen, closeOnboarding } = useDialog();

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) closeOnboarding();
    },
    [closeOnboarding],
  );

  if (!onboardingOpen) return null;

  return (
    <Dialog open={onboardingOpen} onOpenChange={handleOpenChange}>
      <DialogPortal>
        <OnboardingWizardInner />
      </DialogPortal>
    </Dialog>
  );
}
