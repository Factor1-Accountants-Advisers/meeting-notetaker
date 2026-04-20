"use client";

import { useState, useCallback, useEffect } from "react";
import { isElectron, getElectronAPI } from "@/lib/electron-bridge";

export interface AuthUser {
  name: string;
  email: string;
}

export function useAuth() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [user, setUser] = useState<AuthUser | null>(null);

  // On mount, try to acquire a token to check if we're signed in
  useEffect(() => {
    if (!isElectron()) {
      setIsLoading(false);
      return;
    }

    const api = getElectronAPI();
    api.getToken()
      .then((token) => {
        // Decode the JWT payload to get user info (name, email)
        try {
          const payload = JSON.parse(atob(token.split('.')[1]));
          setUser({ name: payload.name ?? '', email: payload.preferred_username ?? payload.upn ?? '' });
        } catch {
          setUser({ name: 'User', email: '' });
        }
        setIsAuthenticated(true);
      })
      .catch(() => {
        setIsAuthenticated(false);
      })
      .finally(() => setIsLoading(false));
  }, []);

  const login = useCallback(async () => {
    if (!isElectron()) return;
    const api = getElectronAPI();
    try {
      const token = await api.signIn();
      const payload = JSON.parse(atob(token.split('.')[1]));
      setUser({ name: payload.name ?? '', email: payload.preferred_username ?? payload.upn ?? '' });
      setIsAuthenticated(true);
    } catch {
      setIsAuthenticated(false);
    }
  }, []);

  const logout = useCallback(async () => {
    if (!isElectron()) return;
    const api = getElectronAPI();
    await api.signOut();
    setUser(null);
    setIsAuthenticated(false);
  }, []);

  const getIdToken = useCallback(async (): Promise<string> => {
    if (!isElectron()) throw new Error("Not in Electron");
    return getElectronAPI().getToken();
  }, []);

  return { user, isAuthenticated, isLoading, login, logout, getIdToken };
}
