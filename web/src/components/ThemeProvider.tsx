"use client";

import { useEffect } from "react";

const STORAGE_KEY = "ui-theme";

function getPreferredTheme(): "light" | "dark" {
  if (typeof window === "undefined") return "light";

  const saved = window.localStorage.getItem(STORAGE_KEY);
  if (saved === "light" || saved === "dark") return saved;
  return "light";
}

export default function ThemeProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  useEffect(() => {
    const theme = getPreferredTheme();
    document.documentElement.dataset.theme = theme;
  }, []);

  return <>{children}</>;
}
