"use client";

import { ReactNode, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/useAuth";
import { setTokenProvider } from "@/lib/api";

export default function AuthGuard({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading, getIdToken } = useAuth();
  const router = useRouter();

  // Register token provider for API client
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
