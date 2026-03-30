"use client";

interface SearchFilterProps {
  search: string;
  onSearchChange: (value: string) => void;
  statusFilter: string;
  onStatusChange: (value: string) => void;
}

const STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  { value: "processing", label: "Processing" },
  { value: "transcribing", label: "Transcribing" },
  { value: "summarising", label: "Summarising" },
  { value: "complete", label: "Complete" },
  { value: "failed", label: "Failed" },
];

export default function SearchFilter({
  search,
  onSearchChange,
  statusFilter,
  onStatusChange,
}: SearchFilterProps) {
  return (
    <div className="mb-4 flex gap-3">
      <input
        type="text"
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        placeholder="Search meetings..."
        className="h-11 flex-1 rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--surface-soft)] px-4 text-sm text-[color:var(--text-primary)] placeholder:text-[color:var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-[color:var(--accent-soft)]"
      />
      <select
        value={statusFilter}
        onChange={(e) => onStatusChange(e.target.value)}
        className="h-11 rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--surface-soft)] px-4 text-sm text-[color:var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[color:var(--accent-soft)]"
      >
        {STATUS_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}
