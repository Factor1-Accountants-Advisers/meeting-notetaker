"use client";

import { ReactNode, useEffect, useRef, useState } from "react";
import { MsalProvider } from "@azure/msal-react";
import { PublicClientApplication } from "@azure/msal-browser";
import { msalConfig } from "@/lib/msal-config";

let msalInstance: PublicClientApplication | null = null;

function getMsalInstance() {
  if (!msalInstance) {
    msalInstance = new PublicClientApplication(msalConfig);
  }
  return msalInstance;
}

export default function AuthProvider({ children }: { children: ReactNode }) {
  const instanceRef = useRef<PublicClientApplication | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    instanceRef.current = getMsalInstance();
    setReady(true);
  }, []);

  if (!ready || !instanceRef.current) return null;
  return <MsalProvider instance={instanceRef.current}>{children}</MsalProvider>;
}
