import AuthGuard from "@/components/AuthGuard";
import IconSidebar from "@/components/IconSidebar";

export default function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AuthGuard>
      <div className="flex h-screen overflow-hidden bg-gray-950">
        <IconSidebar />
        <main className="flex-1 p-6 overflow-hidden">{children}</main>
      </div>
    </AuthGuard>
  );
}
