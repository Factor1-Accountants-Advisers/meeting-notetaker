"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/", label: "Meetings", icon: "📋" },
  { href: "/action-items", label: "Action Items", icon: "✅" },
];

export default function Nav() {
  const pathname = usePathname();

  return (
    <nav className="w-56 bg-gray-900 text-gray-300 flex flex-col min-h-screen p-4">
      <div className="text-white font-bold text-lg mb-8 px-2">
        Meeting Notes
      </div>
      <ul className="space-y-1 flex-1">
        {links.map((link) => {
          const active =
            link.href === "/"
              ? pathname === "/"
              : pathname.startsWith(link.href);
          return (
            <li key={link.href}>
              <Link
                href={link.href}
                className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors ${
                  active
                    ? "bg-gray-800 text-white"
                    : "hover:bg-gray-800 hover:text-white"
                }`}
              >
                <span>{link.icon}</span>
                {link.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
