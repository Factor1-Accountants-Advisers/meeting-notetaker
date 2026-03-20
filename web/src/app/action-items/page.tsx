"use client";

import { useState, useMemo } from "react";
import { useActionItems } from "@/lib/api";
import ActionItemsTable from "@/components/ActionItemsTable";

export default function ActionItemsPage() {
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined);
  const [ownerFilter, setOwnerFilter] = useState<string>("");
  const { data, error, isLoading } = useActionItems(1, 100, statusFilter);

  // Client-side owner filter (backend doesn't have owner query param)
  const filtered = useMemo(() => {
    if (!data) return [];
    if (!ownerFilter) return data.items;
    const lower = ownerFilter.toLowerCase();
    return data.items.filter((i) => i.owner_name?.toLowerCase().includes(lower));
  }, [data, ownerFilter]);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Action Items</h1>
        <div className="flex gap-3">
          <input
            type="text"
            placeholder="Filter by owner..."
            value={ownerFilter}
            onChange={(e) => setOwnerFilter(e.target.value)}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <select
            value={statusFilter ?? "all"}
            onChange={(e) =>
              setStatusFilter(e.target.value === "all" ? undefined : e.target.value)
            }
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="all">All</option>
            <option value="open">Open</option>
            <option value="complete">Complete</option>
          </select>
        </div>
      </div>

      {isLoading && <div className="text-gray-500">Loading...</div>}
      {error && <div className="text-red-600">Failed to load action items.</div>}
      {data && (
        <>
          <ActionItemsTable items={filtered} showMeetingLink />
          <p className="mt-4 text-sm text-gray-500">
            {filtered.length} of {data.total} item{data.total !== 1 ? "s" : ""}
          </p>
        </>
      )}
    </div>
  );
}
