"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getUpcomingMeetings = getUpcomingMeetings;
const axios_1 = __importDefault(require("axios"));
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
async function getUpcomingMeetings(accessToken) {
    const now = new Date();
    const params = new URLSearchParams({
        startDateTime: now.toISOString(),
        endDateTime: new Date(now.getTime() + 8 * 3600000).toISOString(),
        $select: 'id,subject,start,end,attendees',
        $top: '20',
        $orderby: 'start/dateTime asc',
    });
    const response = await axios_1.default.get(`${GRAPH_BASE}/me/calendarView?${params}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return response.data.value.map((evt) => ({
        id: evt.id,
        subject: evt.subject,
        start: evt.start.dateTime + 'Z',
        end: evt.end.dateTime + 'Z',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        attendees: (evt.attendees ?? []).map((a) => ({
            name: a.emailAddress?.name ?? '',
            email: a.emailAddress?.address ?? '',
        })),
    }));
}
//# sourceMappingURL=graph.js.map