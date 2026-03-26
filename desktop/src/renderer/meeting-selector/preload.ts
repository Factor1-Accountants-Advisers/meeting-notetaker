import { contextBridge, ipcRenderer } from 'electron';

// Re-declared here to avoid cross-rootDir import; must stay in sync with src/main/graph.ts
interface CalendarAttendee {
  name: string;
  email: string;
}

interface CalendarEvent {
  id: string;
  subject: string;
  start: string;
  end: string;
  attendees: CalendarAttendee[];
}

contextBridge.exposeInMainWorld('meetingSelector', {
  getCalendar: (): Promise<CalendarEvent[]> => ipcRenderer.invoke('graph:get-calendar'),
  selectMeeting: (event: CalendarEvent): Promise<void> => ipcRenderer.invoke('meeting-selector:select', event),
  closeWindow: (): void => ipcRenderer.send('meeting-selector:close'),
});
