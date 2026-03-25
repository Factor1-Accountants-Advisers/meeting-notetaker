"use client";

import { useMsal, useIsAuthenticated } from "@azure/msal-react";
import { InteractionRequiredAuthError } from "@azure/msal-browser";
import { useCallback, useMemo } from "react";
import { loginRequest } from "@/lib/msal-config";

export interface AuthUser {
  name: string;
  email: string;
}

export function useAuth() {
  const { instance, accounts, inProgress } = useMsal();
  const isAuthenticated = useIsAuthenticated();
  const isLoading = inProgress !== "none";

  const user: AuthUser | null = useMemo(() => {
    if (accounts.length === 0) return null;
    const account = accounts[0];
    return {
      name: account.name || "",
      email: account.username || "",
    };
  }, [accounts]);

  const login = useCallback(async () => {
    await instance.loginRedirect(loginRequest);
  }, [instance]);

  const logout = useCallback(async () => {
    await instance.logoutRedirect({
      postLogoutRedirectUri: "/login",
    });
  }, [instance]);

  const getIdToken = useCallback(async (): Promise<string> => {
    if (accounts.length === 0) {
      throw new Error("No authenticated account");
    }

    try {
      const response = await instance.acquireTokenSilent({
        ...loginRequest,
        account: accounts[0],
      });
      return response.idToken;
    } catch (error) {
      if (error instanceof InteractionRequiredAuthError) {
        await instance.acquireTokenRedirect(loginRequest);
        throw new Error("Redirecting for token acquisition");
      }
      throw error;
    }
  }, [instance, accounts]);

  return { user, isAuthenticated, isLoading, login, logout, getIdToken };
}
