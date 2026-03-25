"use client";

import { ReactNode, useEffect, useState } from "react";
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
  const [instance, setInstance] = useState<PublicClientApplication | null>(null);

  useEffect(() => {
    setInstance(getMsalInstance());
  }, []);

  if (!instance) return null;
  return <MsalProvider instance={instance}>{children}</MsalProvider>;
}
