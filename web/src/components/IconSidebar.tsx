"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Calendar, CheckSquare, Settings, PenTool } from "lucide-react";
import { useAuth } from "@/lib/useAuth";
import ThemeToggle from "./ThemeToggle";

const navItems = [
  { href: "/", label: "Meetings", icon: Calendar },
  { href: "/action-items", label: "Action Items", icon: CheckSquare },
  { href: "/settings", label: "Settings", icon: Settings },
];

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

export default function IconSidebar() {
  const pathname = usePathname();
  const { user } = useAuth();

  return (
    <nav className="flex h-full w-[74px] flex-col items-center gap-2 border-r border-[color:var(--border-subtle)] bg-[color:var(--sidebar-bg)] px-3 py-5">
      <div className="mb-4 rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--surface-elevated)] p-2.5 text-[color:var(--text-primary)] shadow-[var(--shadow-soft)]">
        <PenTool className="h-5 w-5" />
      </div>

      {navItems.map((item) => {
        const active =
          item.href === "/"
            ? pathname === "/" || pathname.startsWith("/meetings")
            : pathname.startsWith(item.href);
        const Icon = item.icon;

        return (
          <Link
            key={item.href}
            href={item.href}
            title={item.label}
            aria-label={item.label}
            className={`flex h-11 w-11 items-center justify-center rounded-2xl border transition-[background-color,border-color,color,box-shadow] duration-150 ${
              active
                ? "border-[color:var(--border-strong)] bg-[color:var(--surface-elevated)] text-[color:var(--text-primary)] shadow-[var(--shadow-soft)]"
                : "border-transparent text-[color:var(--text-muted)] hover:border-[color:var(--border-subtle)] hover:bg-[color:var(--surface)] hover:text-[color:var(--text-primary)]"
            }`}
          >
            <Icon className="h-5 w-5" />
          </Link>
        );
      })}

      <div className="flex-1" />

      <ThemeToggle />

      {user && (
        <Link
          href="/settings"
          title={user.name}
          aria-label={`${user.name} — Settings`}
          className="mt-2 flex h-10 w-10 items-center justify-center rounded-full border border-[color:var(--border-subtle)] bg-[color:var(--surface-elevated)] text-xs font-medium text-[color:var(--text-primary)] shadow-[var(--shadow-soft)] transition hover:border-[color:var(--border-strong)]"
        >
          {getInitials(user.name)}
        </Link>
      )}
    </nav>
  );
}
