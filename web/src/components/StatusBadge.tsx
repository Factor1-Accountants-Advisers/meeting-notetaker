const statusConfig: Record<string, { label: string; className: string }> = {
  processing: { label: "Processing", className: "bg-[color:var(--accent-soft)] text-[color:var(--accent-text)]" },
  transcribing: { label: "Transcribing", className: "bg-[color:var(--accent-soft)] text-[color:var(--accent-text)]" },
  diarising: { label: "Identifying Speakers", className: "bg-[rgba(124,58,237,0.1)] text-[rgb(109,40,217)]" },
  summarising: { label: "Summarising", className: "bg-[rgba(245,158,11,0.12)] text-[rgb(180,83,9)]" },
  complete: { label: "Complete", className: "bg-[rgba(16,185,129,0.12)] text-[rgb(5,150,105)]" },
  failed: { label: "Failed", className: "bg-[color:var(--danger-soft)] text-[color:var(--danger)]" },
};

export default function StatusBadge({ status }: { status: string }) {
  const config = statusConfig[status] ?? {
    label: status,
    className: "bg-[color:var(--surface-soft)] text-[color:var(--text-secondary)]",
  };
  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${config.className}`}
    >
      {config.label}
    </span>
  );
}
