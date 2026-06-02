import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import LoginPage from "./page";

const mockLogin = vi.fn();
const mockReplace = vi.fn();
let mockIsElectron = false;
let mockIsAuthenticated = false;
let mockIsLoading = false;

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace }),
}));

vi.mock("@/lib/useAuth", () => ({
  useAuth: () => ({
    login: mockLogin,
    isAuthenticated: mockIsAuthenticated,
    isLoading: mockIsLoading,
  }),
}));

vi.mock("@/lib/electron-bridge", () => ({
  isElectron: () => mockIsElectron,
}));

describe("LoginPage", () => {
  beforeEach(() => {
    mockLogin.mockReset();
    mockReplace.mockReset();
    mockIsElectron = false;
    mockIsAuthenticated = false;
    mockIsLoading = false;
  });

  it("explains that browser sign-in is unavailable outside Electron", () => {
    render(<LoginPage />);

    expect(screen.getByRole("button", { name: "Open in desktop app" })).toBeDisabled();
    expect(screen.getByText(/Sign-in is only available in the desktop app/i)).toBeVisible();
  });

  it("calls login when running inside Electron", async () => {
    mockIsElectron = true;
    mockLogin.mockResolvedValue(undefined);

    render(<LoginPage />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    });

    expect(mockLogin).toHaveBeenCalledTimes(1);
  });
});
