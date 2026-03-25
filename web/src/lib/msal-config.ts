import { Configuration, LogLevel } from "@azure/msal-browser";

const tenantId = process.env.NEXT_PUBLIC_AZURE_AD_TENANT_ID;
const clientId = process.env.NEXT_PUBLIC_AZURE_AD_CLIENT_ID;
const redirectUri =
  process.env.NEXT_PUBLIC_AZURE_AD_REDIRECT_URI || "http://localhost:3000/login";

if (!tenantId || !clientId) {
  throw new Error(
    "Missing NEXT_PUBLIC_AZURE_AD_TENANT_ID or NEXT_PUBLIC_AZURE_AD_CLIENT_ID"
  );
}

export const msalConfig: Configuration = {
  auth: {
    clientId,
    authority: `https://login.microsoftonline.com/${tenantId}`,
    redirectUri,
    postLogoutRedirectUri: "/login",
  },
  cache: {
    cacheLocation: "sessionStorage",
    storeAuthStateInCookie: false,
  },
  system: {
    loggerOptions: {
      logLevel: LogLevel.Warning,
      loggerCallback: (level, message, containsPii) => {
        if (containsPii) return;
        if (level === LogLevel.Error) console.error(message);
        else if (level === LogLevel.Warning) console.warn(message);
      },
    },
  },
};

export const loginRequest = {
  scopes: ["openid", "profile", "User.Read"],
};
