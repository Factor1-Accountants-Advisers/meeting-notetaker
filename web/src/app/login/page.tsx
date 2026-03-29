"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
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
    <div className="flex items-center justify-center min-h-screen bg-gray-950">
      <div className="text-center max-w-md mx-auto p-8">
        <h1 className="text-3xl font-bold text-gray-100 mb-4">Meeting Note-Taker</h1>
        <p className="text-gray-400 mb-8">Sign in with your organisation account to continue.</p>
        <button
          onClick={handleLogin}
          disabled={signingIn}
          className="bg-blue-600 text-white px-8 py-3 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          {signingIn ? "Signing in..." : "Sign in"}
        </button>
        {signingIn && (
          <p className="mt-4 text-sm text-gray-500">
            A device code prompt will appear in a separate window. Follow the instructions to complete sign-in.
          </p>
        )}
      </div>
    </div>
  );
}
