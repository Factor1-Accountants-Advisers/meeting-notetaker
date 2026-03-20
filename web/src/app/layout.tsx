import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import Nav from "@/components/Nav";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Meeting Note-Taker",
  description: "AI-powered meeting transcription and summarisation",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={`${inter.className} flex bg-gray-50`}>
        <Nav />
        <main className="flex-1 p-8 overflow-auto min-h-screen">
          {children}
        </main>
      </body>
    </html>
  );
}
