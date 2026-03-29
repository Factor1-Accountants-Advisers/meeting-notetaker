"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Calendar, CheckSquare, Settings, PenTool } from "lucide-react";
import { useAuth } from "@/lib/useAuth";

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
    <nav className="w-14 bg-gray-900 flex flex-col items-center py-4 h-full gap-1">
      {/* Brand mark */}
      <div className="mb-6 text-gray-400">
        <PenTool className="w-6 h-6" />
      </div>

      {/* Nav icons */}
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
            className={`w-10 h-10 flex items-center justify-center rounded-lg transition-colors ${
              active
                ? "bg-blue-600/20 text-blue-400"
                : "text-gray-500 hover:bg-gray-800 hover:text-gray-300"
            }`}
          >
            <Icon className="w-5 h-5" />
          </Link>
        );
      })}

      {/* Spacer */}
      <div className="flex-1" />

      {/* User avatar */}
      {user && (
        <Link
          href="/settings"
          title={user.name}
          aria-label={`${user.name} — Settings`}
          className="w-9 h-9 rounded-full bg-gray-700 text-gray-300 text-xs font-medium flex items-center justify-center hover:bg-gray-600 transition-colors"
        >
          {getInitials(user.name)}
        </Link>
      )}
    </nav>
  );
}
