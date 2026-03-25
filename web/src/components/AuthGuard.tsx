"use client";

import { ReactNode, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/useAuth";
import { setTokenProvider } from "@/lib/api";

export default function AuthGuard({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading, getIdToken } = useAuth();
  const router = useRouter();
  const tokenRegistered = useRef(false);

  // Register token provider during render (not in useEffect)
  // so it's available before children's effects fire SWR fetches
  if (isAuthenticated && !tokenRegistered.current) {
    setTokenProvider(getIdToken);
    tokenRegistered.current = true;
  }

  // Update token provider when getIdToken reference changes
  useEffect(() => {
    if (isAuthenticated) {
      setTokenProvider(getIdToken);
    }
  }, [isAuthenticated, getIdToken]);

  // Redirect to login if not authenticated
  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.replace("/login");
    }
  }, [isLoading, isAuthenticated, router]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-gray-500">Loading...</div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return null;
  }

  return <>{children}</>;
}
