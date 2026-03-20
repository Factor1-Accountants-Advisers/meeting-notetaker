import type { MeetingDetail } from "@/types";
import StatusBadge from "./StatusBadge";

function formatDuration(seconds: number | null): string {
  if (!seconds) return "";
  const m = Math.floor(seconds / 60);
  return `${m} min`;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "";
  return new Date(dateStr).toLocaleDateString("en-AU", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function MeetingHeader({ meeting }: { meeting: MeetingDetail }) {
  return (
    <div className="mb-6">
      <div className="flex items-center gap-3 mb-2">
        <h1 className="text-2xl font-bold text-gray-900">{meeting.title}</h1>
        <StatusBadge status={meeting.status} />
      </div>
      <div className="flex flex-wrap gap-4 text-sm text-gray-600">
        {meeting.scheduled_time && <span>{formatDate(meeting.scheduled_time)}</span>}
        {meeting.duration_seconds && <span>{formatDuration(meeting.duration_seconds)}</span>}
      </div>
      {meeting.participants.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {meeting.participants.map((p) => (
            <span
              key={p.id}
              className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700"
            >
              {p.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
