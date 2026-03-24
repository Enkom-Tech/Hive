import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { workersApi, type BoardAgentOverviewRow } from "@/api/workers";
import { queryKeys } from "@/lib/queryKeys";
import { ApiError } from "@/api/client";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  workerInstanceId: string;
  droneLabel: string;
  /** Unassigned board agents eligible to bind */
  candidates: BoardAgentOverviewRow[];
};

export function WorkerAttachIdentityDialog({
  open,
  onOpenChange,
  companyId,
  workerInstanceId,
  droneLabel,
  candidates,
}: Props) {
  const queryClient = useQueryClient();
  const [agentId, setAgentId] = useState<string>("");

  const bind = useMutation({
    mutationFn: () => workersApi.bindAgentToWorkerInstance(companyId, workerInstanceId, agentId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.workers.overview(companyId) });
      onOpenChange(false);
      setAgentId("");
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Attach identity to drone</DialogTitle>
          <DialogDescription>
            Bind a <strong className="text-foreground">managed_worker</strong> board identity to{" "}
            <span className="font-medium text-foreground">{droneLabel}</span>. The worker process must already be connected; this updates the board only (no host
            SSH).
          </DialogDescription>
        </DialogHeader>
        {candidates.length === 0 ? (
          <p className="text-sm text-muted-foreground">No unassigned identities in the table below. Add an agent or unbind one from another drone first.</p>
        ) : (
          <div className="space-y-2">
            <label className="text-xs font-medium text-foreground">Board identity</label>
            <Select value={agentId} onValueChange={setAgentId}>
              <SelectTrigger>
                <SelectValue placeholder="Select identity…" />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((a) => (
                  <SelectItem key={a.agentId} value={a.agentId}>
                    {a.name} <span className="text-muted-foreground font-mono text-xs">({a.urlKey})</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        {bind.isError ? (
          <p className="text-sm text-destructive">
            {bind.error instanceof ApiError ? bind.error.message : "Could not attach identity."}
          </p>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!agentId || candidates.length === 0 || bind.isPending}
            onClick={() => bind.mutate()}
          >
            {bind.isPending ? "Attaching…" : "Attach"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
