import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@/lib/router";
import { accessApi } from "../api/access";
import { authApi } from "../api/auth";
import { healthApi } from "../api/health";
import { ApiUnreachableNotice } from "@/components/ApiUnreachableNotice";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import type { JoinRequest } from "@hive/shared";

type JoinType = "human" | "agent";

const adapterLabels: Record<string, string> = {
  managed_worker: "Managed worker",
};

function dateTime(value: string) {
  return new Date(value).toLocaleString();
}

function readNestedString(value: unknown, path: string[]): string | null {
  let current: unknown = value;
  for (const segment of path) {
    if (!current || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === "string" && current.trim().length > 0 ? current : null;
}

export function InviteLandingPage() {
  const queryClient = useQueryClient();
  const params = useParams();
  const token = (params.token ?? "").trim();
  const [joinType, setJoinType] = useState<JoinType>("human");
  const [agentName, setAgentName] = useState("");
  const [adapterType, setAdapterType] = useState<string>("managed_worker");
  const [capabilities, setCapabilities] = useState("");
  const [bootstrapName, setBootstrapName] = useState("");
  const [bootstrapEmail, setBootstrapEmail] = useState("");
  const [bootstrapPassword, setBootstrapPassword] = useState("");
  const [result, setResult] = useState<{ kind: "bootstrap" | "join"; payload: unknown } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
  });
  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });
  const inviteQuery = useQuery({
    queryKey: queryKeys.access.invite(token),
    queryFn: () => accessApi.getInvite(token),
    enabled: token.length > 0,
    retry: false,
  });

  const invite = inviteQuery.data;
  const allowedJoinTypes = invite?.allowedJoinTypes ?? "both";
  const availableJoinTypes = useMemo(() => {
    if (invite?.inviteType === "bootstrap_ceo") return ["human"] as JoinType[];
    if (allowedJoinTypes === "both") return ["human", "agent"] as JoinType[];
    return [allowedJoinTypes] as JoinType[];
  }, [invite?.inviteType, allowedJoinTypes]);

  useEffect(() => {
    if (!availableJoinTypes.includes(joinType)) {
      setJoinType(availableJoinTypes[0] ?? "human");
    }
  }, [availableJoinTypes, joinType]);

  const bootstrapPending = healthQuery.data?.bootstrapStatus === "bootstrap_pending";

  const allowAnonymousBootstrap =
    invite?.inviteType === "bootstrap_ceo" &&
    healthQuery.data?.deploymentMode === "authenticated" &&
    bootstrapPending === true &&
    !sessionQuery.data;

  const requiresAuthForHuman =
    joinType === "human" &&
    healthQuery.data?.deploymentMode === "authenticated" &&
    !sessionQuery.data &&
    !allowAnonymousBootstrap;

  const anonymousBootstrapFormValid =
    bootstrapName.trim().length > 0 &&
    bootstrapEmail.trim().length > 0 &&
    bootstrapPassword.length >= 8;

  const acceptMutation = useMutation({
    mutationFn: async () => {
      if (!invite) throw new Error("Invite not found");
      if (invite.inviteType === "bootstrap_ceo") {
        if (sessionQuery.data) {
          return accessApi.acceptInvite(token, { requestType: "human" });
        }
        if (healthQuery.data?.bootstrapStatus === "bootstrap_pending") {
          return accessApi.acceptInvite(token, {
            requestType: "human",
            name: bootstrapName.trim(),
            email: bootstrapEmail.trim(),
            password: bootstrapPassword,
          });
        }
        throw new Error("Sign in to accept this invite.");
      }
      if (joinType === "human") {
        return accessApi.acceptInvite(token, { requestType: "human" });
      }
      return accessApi.acceptInvite(token, {
        requestType: "agent",
        agentName: agentName.trim(),
        adapterType,
        capabilities: capabilities.trim() || null,
      });
    },
    onSuccess: async (payload) => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      const asBootstrap =
        payload && typeof payload === "object" && "bootstrapAccepted" in (payload as Record<string, unknown>);
      setResult({ kind: asBootstrap ? "bootstrap" : "join", payload });
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Failed to accept invite");
    },
  });

  if (!token) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-destructive">Invalid invite token.</div>;
  }

  if (inviteQuery.isLoading || healthQuery.isLoading || sessionQuery.isLoading) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">Loading invite...</div>;
  }

  if (healthQuery.error) {
    return <ApiUnreachableNotice error={healthQuery.error} />;
  }

  if (sessionQuery.error) {
    return <ApiUnreachableNotice error={sessionQuery.error} />;
  }

  if (inviteQuery.error || !invite) {
    return (
      <div className="mx-auto max-w-xl py-10">
        <div className="rounded-lg border border-border bg-card p-6">
          <h1 className="text-lg font-semibold">Invite not available</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            This invite may be expired, revoked, or already used.
          </p>
        </div>
      </div>
    );
  }

  if (result?.kind === "bootstrap") {
    const payload = result.payload as Record<string, unknown> | null;
    const createdAccount = payload?.createdAccount === true;
    return (
      <div className="mx-auto max-w-xl py-10">
        <div className="rounded-lg border border-border bg-card p-6">
          <h1 className="text-lg font-semibold">Bootstrap complete</h1>
          {createdAccount ? (
            <>
              <p className="mt-2 text-sm text-muted-foreground">
                Your admin account is ready. Sign in with the email and password you chose to open the board.
              </p>
              <Button asChild className="mt-4">
                <Link to="/auth">Sign in</Link>
              </Button>
            </>
          ) : (
            <>
              <p className="mt-2 text-sm text-muted-foreground">
                The first instance admin is now configured. You can continue to the board.
              </p>
              <Button asChild className="mt-4">
                <Link to="/">Open board</Link>
              </Button>
            </>
          )}
        </div>
      </div>
    );
  }

  if (result?.kind === "join") {
    const payload = result.payload as JoinRequest & {
      claimSecret?: string;
      claimApiKeyPath?: string;
      onboarding?: Record<string, unknown>;
      diagnostics?: Array<{
        code: string;
        level: "info" | "warn";
        message: string;
        hint?: string;
      }>;
    };
    const claimSecret = typeof payload.claimSecret === "string" ? payload.claimSecret : null;
    const claimApiKeyPath = typeof payload.claimApiKeyPath === "string" ? payload.claimApiKeyPath : null;
    const onboardingSkillUrl = readNestedString(payload.onboarding, ["skill", "url"]);
    const onboardingSkillPath = readNestedString(payload.onboarding, ["skill", "path"]);
    const onboardingInstallPath = readNestedString(payload.onboarding, ["skill", "installPath"]);
    const onboardingTextUrl = readNestedString(payload.onboarding, ["textInstructions", "url"]);
    const onboardingTextPath = readNestedString(payload.onboarding, ["textInstructions", "path"]);
    const diagnostics = Array.isArray(payload.diagnostics) ? payload.diagnostics : [];
    return (
      <div className="mx-auto max-w-xl py-10">
        <div className="rounded-lg border border-border bg-card p-6">
          <h1 className="text-lg font-semibold">Join request submitted</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Your request is pending admin approval. You will not have access until approved.
          </p>
          <div className="mt-4 rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
            Request ID: <span className="font-mono">{payload.id}</span>
          </div>
          {claimSecret && claimApiKeyPath && (
            <div className="mt-3 space-y-1 rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
              <p className="font-medium text-foreground">One-time claim secret (save now)</p>
              <p className="font-mono break-all">{claimSecret}</p>
              <p className="font-mono break-all">POST {claimApiKeyPath}</p>
            </div>
          )}
          {(onboardingSkillUrl || onboardingSkillPath || onboardingInstallPath) && (
            <div className="mt-3 space-y-1 rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
              <p className="font-medium text-foreground">Hive skill bootstrap</p>
              {onboardingSkillUrl && <p className="font-mono break-all">GET {onboardingSkillUrl}</p>}
              {!onboardingSkillUrl && onboardingSkillPath && <p className="font-mono break-all">GET {onboardingSkillPath}</p>}
              {onboardingInstallPath && <p className="font-mono break-all">Install to {onboardingInstallPath}</p>}
            </div>
          )}
          {(onboardingTextUrl || onboardingTextPath) && (
            <div className="mt-3 space-y-1 rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
              <p className="font-medium text-foreground">Agent-readable onboarding text</p>
              {onboardingTextUrl && <p className="font-mono break-all">GET {onboardingTextUrl}</p>}
              {!onboardingTextUrl && onboardingTextPath && <p className="font-mono break-all">GET {onboardingTextPath}</p>}
            </div>
          )}
          {diagnostics.length > 0 && (
            <div className="mt-3 space-y-1 rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
              <p className="font-medium text-foreground">Connectivity diagnostics</p>
              {diagnostics.map((diag, idx) => (
                <div key={`${diag.code}:${idx}`} className="space-y-0.5">
                  <p className={diag.level === "warn" ? "text-amber-600 dark:text-amber-400" : undefined}>
                    [{diag.level}] {diag.message}
                  </p>
                  {diag.hint && <p className="font-mono break-all">{diag.hint}</p>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl py-10">
      <div className="rounded-lg border border-border bg-card p-6">
        <h1 className="text-xl font-semibold">
          {invite.inviteType === "bootstrap_ceo" ? "Bootstrap your Hive instance" : "Join this Hive company"}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">Invite expires {dateTime(invite.expiresAt)}.</p>

        {invite.inviteType !== "bootstrap_ceo" && (
          <div className="mt-5 flex gap-2">
            {availableJoinTypes.map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => setJoinType(type)}
                className={`rounded-md border px-3 py-1.5 text-sm ${
                  joinType === type
                    ? "border-foreground bg-foreground text-background"
                    : "border-border bg-background text-foreground"
                }`}
              >
                Join as {type}
              </button>
            ))}
          </div>
        )}

        {joinType === "agent" && invite.inviteType !== "bootstrap_ceo" && (
          <div className="mt-4 space-y-3">
            <label className="block text-sm">
              <span className="mb-1 block text-muted-foreground">Agent name</span>
              <input
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                value={agentName}
                onChange={(event) => setAgentName(event.target.value)}
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-muted-foreground">Adapter type</span>
              <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-foreground">
                {adapterLabels["managed_worker"] ?? "Managed worker"}
              </div>
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-muted-foreground">Capabilities (optional)</span>
              <textarea
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                rows={4}
                value={capabilities}
                onChange={(event) => setCapabilities(event.target.value)}
              />
            </label>
          </div>
        )}

        {invite.inviteType === "bootstrap_ceo" && allowAnonymousBootstrap && (
          <div className="mt-5 space-y-3">
            <p className="text-sm text-muted-foreground">
              Create the first admin account for this instance. You can also register from the sign-in page while no admin
              exists; this form ties acceptance of this invite to that account.
            </p>
            <label className="block text-sm">
              <span className="mb-1 block text-muted-foreground">Name</span>
              <input
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                value={bootstrapName}
                onChange={(e) => setBootstrapName(e.target.value)}
                autoComplete="name"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-muted-foreground">Email</span>
              <input
                type="email"
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                value={bootstrapEmail}
                onChange={(e) => setBootstrapEmail(e.target.value)}
                autoComplete="email"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-muted-foreground">Password (at least 8 characters)</span>
              <input
                type="password"
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                value={bootstrapPassword}
                onChange={(e) => setBootstrapPassword(e.target.value)}
                autoComplete="new-password"
              />
            </label>
          </div>
        )}

        {requiresAuthForHuman && (
          <div className="mt-4 rounded-md border border-border bg-muted/30 p-3 text-sm">
            Sign in before accepting this invite. If this instance has no admin yet, open the sign-in page and use Create
            account, or complete the form above when you opened a bootstrap invite link.
            <div className="mt-2">
              <Button asChild size="sm" variant="outline">
                <Link to={`/auth?next=${encodeURIComponent(`/invite/${token}`)}`}>Sign in</Link>
              </Button>
            </div>
          </div>
        )}

        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}

        <Button
          className="mt-5"
          disabled={
            acceptMutation.isPending ||
            (joinType === "agent" && invite.inviteType !== "bootstrap_ceo" && agentName.trim().length === 0) ||
            requiresAuthForHuman ||
            (allowAnonymousBootstrap && !anonymousBootstrapFormValid)
          }
          onClick={() => acceptMutation.mutate()}
        >
          {acceptMutation.isPending
            ? "Submitting…"
            : invite.inviteType === "bootstrap_ceo"
              ? "Accept bootstrap invite"
              : "Submit join request"}
        </Button>
      </div>
    </div>
  );
}
