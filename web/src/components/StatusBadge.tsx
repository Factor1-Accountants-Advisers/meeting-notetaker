const statusConfig: Record<string, { label: string; className: string }> = {
  processing: { label: "Processing", className: "bg-blue-900/50 text-blue-300" },
  transcribing: { label: "Transcribing", className: "bg-blue-900/50 text-blue-300" },
  diarising: { label: "Identifying Speakers", className: "bg-purple-900/50 text-purple-300" },
  summarising: { label: "Summarising", className: "bg-yellow-900/50 text-yellow-300" },
  complete: { label: "Complete", className: "bg-green-900/50 text-green-300" },
  failed: { label: "Failed", className: "bg-red-900/50 text-red-300" },
};

export default function StatusBadge({ status }: { status: string }) {
  const config = statusConfig[status] ?? {
    label: status,
    className: "bg-gray-800 text-gray-300",
  };
  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${config.className}`}
    >
      {config.label}
    </span>
  );
}
