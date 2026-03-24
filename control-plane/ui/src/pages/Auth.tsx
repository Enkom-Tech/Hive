import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "@/lib/router";
import { authApi } from "../api/auth";
import { companiesApi } from "../api/companies";
import { healthApi } from "../api/health";
import { ApiUnreachableNotice } from "@/components/ApiUnreachableNotice";
import { apiUnreachableUserMessage } from "@/lib/api-unreachable";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { AsciiArtAnimation } from "@/components/AsciiArtAnimation";
import { Sparkles } from "lucide-react";

type AuthMode = "sign_in" | "sign_up";

export function AuthPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [mode, setMode] = useState<AuthMode>("sign_in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const nextPath = useMemo(() => searchParams.get("next") || "/", [searchParams]);
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
  });
  const signUpDisabled = healthQuery.data?.auth?.signUpDisabled ?? false;

  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });
  const session = sessionQuery.data;
  const sessionUserId = session?.user?.id;

  const navigateAfterAuth = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
    try {
      const companies = await queryClient.fetchQuery({
        queryKey: queryKeys.companies.all,
        queryFn: () => companiesApi.list(),
      });
      const dest = companies.length === 0 ? "/" : nextPath;
      navigate(dest, { replace: true });
    } catch {
      navigate(nextPath, { replace: true });
    }
  }, [queryClient, nextPath, navigate]);

  useEffect(() => {
    if (!sessionUserId) return;
    void navigateAfterAuth();
  }, [sessionUserId, navigateAfterAuth]);

  useEffect(() => {
    if (signUpDisabled && mode === "sign_up") {
      setMode("sign_in");
    }
  }, [signUpDisabled, mode]);

  const mutation = useMutation({
    mutationFn: async () => {
      if (mode === "sign_in") {
        await authApi.signInEmail({ email: email.trim(), password });
        return;
      }
      await authApi.signUpEmail({
        name: name.trim(),
        email: email.trim(),
        password,
      });
    },
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      await queryClient.fetchQuery({
        queryKey: queryKeys.auth.session,
        queryFn: () => authApi.getSession(),
      });
      await navigateAfterAuth();
    },
    onError: (err) => {
      setError(apiUnreachableUserMessage(err));
    },
  });

  const canSubmit =
    email.trim().length > 0 &&
    password.trim().length >= 8 &&
    (mode === "sign_in" || name.trim().length > 0);

  if (sessionQuery.isError) {
    return <ApiUnreachableNotice error={sessionQuery.error} />;
  }

  if (sessionQuery.isLoading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 flex bg-background">
      {/* Left half — form */}
      <div className="w-full md:w-1/2 flex flex-col overflow-y-auto">
        <div className="w-full max-w-md mx-auto my-auto px-8 py-12">
          <div className="flex items-center gap-2 mb-8">
            <Sparkles className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">Hive</span>
          </div>

          <h1 className="text-xl font-semibold">
            {mode === "sign_in" ? "Sign in to Hive" : "Create your Hive account"}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {mode === "sign_in"
              ? "Use your email and password to access this instance."
              : "Create an account for this instance. Email confirmation is not enabled."}
          </p>

          <form
            className="mt-6 space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              mutation.mutate();
            }}
          >
            {mode === "sign_up" && (
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Name</label>
                <input
                  className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  autoComplete="name"
                  autoFocus
                />
              </div>
            )}
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Email</label>
              <input
                className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                autoFocus={mode === "sign_in"}
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Password</label>
              <input
                className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete={mode === "sign_in" ? "current-password" : "new-password"}
              />
            </div>
            {error && <p className="text-xs text-destructive whitespace-pre-line">{error}</p>}
            <Button type="submit" disabled={!canSubmit || mutation.isPending} className="w-full">
              {mutation.isPending
                ? "Working…"
                : mode === "sign_in"
                  ? "Sign In"
                  : "Create Account"}
            </Button>
          </form>

          {!signUpDisabled && (
            <div className="mt-5 text-sm text-muted-foreground">
              {mode === "sign_in" ? "Need an account?" : "Already have an account?"}{" "}
              <button
                type="button"
                className="font-medium text-foreground underline underline-offset-2 cursor-pointer"
                onClick={() => {
                  setError(null);
                  setMode(mode === "sign_in" ? "sign_up" : "sign_in");
                }}
              >
                {mode === "sign_in" ? "Create one" : "Sign in"}
              </button>
            </div>
          )}
          {signUpDisabled && mode === "sign_in" && (
            <p className="mt-5 text-sm text-muted-foreground">
              New account registration is disabled. Ask an instance admin to create an account for you.
            </p>
          )}
        </div>
      </div>

      {/* Right half — ASCII art animation (hidden on mobile) */}
      <div className="hidden md:block w-1/2 overflow-hidden">
        <AsciiArtAnimation />
      </div>
    </div>
  );
}
