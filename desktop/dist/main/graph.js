"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getUpcomingMeetings = getUpcomingMeetings;
const axios_1 = __importDefault(require("axios"));
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const GRAPH_SELECT_FIELDS = [
    'id',
    'subject',
    'start',
    'end',
    'isCancelled',
    'isAllDay',
    'showAs',
    'type',
    'isOnlineMeeting',
    'onlineMeeting',
    'organizer',
    'attendees',
].join(',');
function asUtcInstant(dateTime) {
    if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(dateTime))
        return dateTime;
    return `${dateTime}Z`;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function shouldIncludeEvent(evt) {
    if (evt.isCancelled) {
        console.log(`[graph] Excluding cancelled event ${evt.id ?? '(unknown)'}`);
        return false;
    }
    if (evt.isAllDay) {
        console.log(`[graph] Excluding all-day event ${evt.id ?? '(unknown)'}`);
        return false;
    }
    const showAs = typeof evt.showAs === 'string' ? evt.showAs.toLowerCase() : '';
    if (showAs === 'free' || showAs === 'oof' || showAs === 'workingElsewhere'.toLowerCase()) {
        console.log(`[graph] Excluding non-busy event ${evt.id ?? '(unknown)'} showAs=${showAs}`);
        return false;
    }
    const hasOnlineMeeting = Boolean(evt.isOnlineMeeting || evt.onlineMeeting);
    if (showAs === 'tentative' && !hasOnlineMeeting) {
        console.log(`[graph] Excluding tentative non-online event ${evt.id ?? '(unknown)'}`);
        return false;
    }
    return true;
}
async function getUpcomingMeetings(accessToken) {
    const now = new Date();
    const params = new URLSearchParams({
        startDateTime: now.toISOString(),
        endDateTime: new Date(now.getTime() + 7 * 24 * 3600000).toISOString(),
        $select: GRAPH_SELECT_FIELDS,
        $top: '20',
        $orderby: 'start/dateTime asc',
    });
    const response = await axios_1.default.get(`${GRAPH_BASE}/me/calendarView?${params}`, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
            Prefer: 'outlook.timezone="UTC"',
        },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return response.data.value
        .filter(shouldIncludeEvent)
        .map((evt) => ({
        id: evt.id,
        subject: evt.subject,
        start: asUtcInstant(evt.start.dateTime),
        end: asUtcInstant(evt.end.dateTime),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        attendees: (evt.attendees ?? []).map((a) => ({
            name: a.emailAddress?.name ?? '',
            email: a.emailAddress?.address ?? '',
        })),
    }));
}
//# sourceMappingURL=graph.js.map