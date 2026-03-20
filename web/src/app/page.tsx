import MeetingList from "@/components/MeetingList";

export default function DashboardPage() {
  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Meetings</h1>
      <MeetingList />
    </div>
  );
}
