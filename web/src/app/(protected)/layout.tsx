import AuthGuard from "@/components/AuthGuard";
import Nav from "@/components/Nav";

export default function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AuthGuard>
      <Nav />
      <main className="flex-1 p-8 overflow-auto min-h-screen">{children}</main>
    </AuthGuard>
  );
}
