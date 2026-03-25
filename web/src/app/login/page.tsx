"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/useAuth";

export default function LoginPage() {
  const { isAuthenticated, isLoading, login } = useAuth();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  // If already authenticated, redirect to dashboard
  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      router.replace("/");
    }
  }, [isLoading, isAuthenticated, router]);

  const handleLogin = async () => {
    try {
      setError(null);
      await login();
    } catch (err) {
      setError("Sign-in failed. Please try again.");
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen w-full">
      <div className="text-center">
        <h1 className="text-2xl font-bold text-gray-900 mb-4">
          Meeting Note-Taker
        </h1>
        <p className="text-gray-600 mb-6">
          Sign in with your Microsoft account to continue.
        </p>
        {error && (
          <p className="text-red-600 text-sm mb-4">{error}</p>
        )}
        <button
          onClick={handleLogin}
          disabled={isLoading}
          className="bg-blue-600 text-white px-6 py-2.5 rounded-md font-medium hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isLoading ? "Loading..." : "Sign in with Microsoft"}
        </button>
      </div>
    </div>
  );
}
