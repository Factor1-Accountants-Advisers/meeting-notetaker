"use client";

import Link from "next/link";
import { useMeetings } from "@/lib/api";
import StatusBadge from "./StatusBadge";

function formatDuration(seconds: number | null): string {
  if (!seconds) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s > 0 ? `${s}s` : ""}`.trim();
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function MeetingList() {
  const { data, error, isLoading } = useMeetings();

  if (isLoading) return <div className="text-gray-500">Loading meetings...</div>;
  if (error) return <div className="text-red-600">Failed to load meetings.</div>;
  if (!data || data.items.length === 0)
    return <div className="text-gray-500">No meetings yet.</div>;

  return (
    <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Date</th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Title</th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Participants</th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Duration</th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200">
          {data.items.map((m) => (
            <tr key={m.id} className="hover:bg-gray-50 transition-colors">
              <td className="px-6 py-4 text-sm text-gray-600 whitespace-nowrap">
                {formatDate(m.scheduled_time)}
              </td>
              <td className="px-6 py-4 text-sm">
                <Link href={`/meetings/${m.id}`} className="text-blue-600 hover:underline font-medium">
                  {m.title}
                </Link>
              </td>
              <td className="px-6 py-4 text-sm text-gray-600">{m.participant_count}</td>
              <td className="px-6 py-4 text-sm text-gray-600">{formatDuration(m.duration_seconds)}</td>
              <td className="px-6 py-4"><StatusBadge status={m.status} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
