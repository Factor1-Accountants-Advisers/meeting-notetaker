import MeetingDetailContent from "./MeetingDetailContent";

// Static export: generate the base /meetings page; IDs resolve client-side
export function generateStaticParams() {
  return [{ id: [] }];
}

export const dynamicParams = false;

export default function MeetingDetailPage() {
  return <MeetingDetailContent />;
}
