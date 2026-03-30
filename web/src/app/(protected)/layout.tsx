import AuthGuard from "@/components/AuthGuard";
import IconSidebar from "@/components/IconSidebar";

export default function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AuthGuard>
      <div className="flex h-screen overflow-hidden bg-[color:var(--app-bg)] text-[color:var(--text-primary)]">
        <IconSidebar />
        <main className="flex-1 overflow-hidden p-5 md:p-6">{children}</main>
      </div>
    </AuthGuard>
  );
}
