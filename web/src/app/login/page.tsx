"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { PenTool } from "lucide-react";
import { useAuth } from "@/lib/useAuth";

export default function LoginPage() {
  const { login, isAuthenticated, isLoading } = useAuth();
  const [signingIn, setSigningIn] = useState(false);
  const router = useRouter();

  // Redirect to dashboard if already authenticated
  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      router.replace("/");
    }
  }, [isLoading, isAuthenticated, router]);

  if (isAuthenticated) {
    return null;
  }

  const handleLogin = async () => {
    setSigningIn(true);
    try {
      await login();
    } finally {
      setSigningIn(false);
    }
  };

  return (
    <div className="min-h-screen bg-[color:var(--app-bg)] px-6 py-10">
      <div className="mx-auto flex min-h-[calc(100vh-5rem)] max-w-5xl items-center justify-center">
        <div className="surface-card w-full max-w-xl rounded-[36px] px-8 py-10 text-center shadow-[var(--shadow-panel)]">
          <div className="mx-auto mb-6 inline-flex h-14 w-14 items-center justify-center rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--surface-soft)] text-[color:var(--text-primary)]">
            <PenTool className="h-6 w-6" />
          </div>
          <h1 className="text-4xl font-semibold tracking-tight text-[color:var(--text-primary)]">
            Note Taker
          </h1>
          <p className="mx-auto mt-4 max-w-md text-sm leading-7 text-[color:var(--text-secondary)]">
            Sign in with your organisation account to open your meetings, record audio, and review notes.
          </p>
          <div className="mt-8">
            <button
              onClick={handleLogin}
              disabled={signingIn}
              className="inline-flex h-12 items-center rounded-full bg-[color:var(--surface-inverse)] px-8 text-sm font-medium text-[color:var(--text-inverse)] transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {signingIn ? "Signing in..." : "Sign in"}
            </button>
          </div>
          {signingIn && (
            <p className="mx-auto mt-4 max-w-md text-sm leading-6 text-[color:var(--text-secondary)]">
              A device code prompt will appear separately. Follow the sign-in steps, then return to Note Taker.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
