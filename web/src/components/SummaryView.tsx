import type { SummaryResponse } from "@/types";

export default function SummaryView({ summary }: { summary: SummaryResponse | null }) {
  if (!summary) {
    return <p className="text-gray-500">Summary not available yet.</p>;
  }

  return (
    <div className="space-y-6">
      {summary.summary_text && (
        <div>
          <h3 className="text-sm font-semibold text-gray-500 uppercase mb-2">Overview</h3>
          <p className="text-gray-800">{summary.summary_text}</p>
        </div>
      )}

      {summary.key_points.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-gray-500 uppercase mb-2">Key Points</h3>
          <ul className="list-disc list-inside space-y-1">
            {summary.key_points.map((point, i) => (
              <li key={i} className="text-gray-800">{point}</li>
            ))}
          </ul>
        </div>
      )}

      {summary.follow_ups.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-gray-500 uppercase mb-2">Follow-ups</h3>
          <ul className="list-disc list-inside space-y-1">
            {summary.follow_ups.map((item, i) => (
              <li key={i} className="text-gray-800">{item}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
