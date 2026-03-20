const statusConfig: Record<string, { label: string; className: string }> = {
  processing: { label: "Processing", className: "bg-yellow-100 text-yellow-800" },
  transcribing: { label: "Transcribing", className: "bg-blue-100 text-blue-800" },
  diarising: { label: "Diarising", className: "bg-blue-100 text-blue-800" },
  summarising: { label: "Summarising", className: "bg-purple-100 text-purple-800" },
  complete: { label: "Complete", className: "bg-green-100 text-green-800" },
  failed: { label: "Failed", className: "bg-red-100 text-red-800" },
};

export default function StatusBadge({ status }: { status: string }) {
  const config = statusConfig[status] ?? {
    label: status,
    className: "bg-gray-100 text-gray-800",
  };
  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${config.className}`}
    >
      {config.label}
    </span>
  );
}
