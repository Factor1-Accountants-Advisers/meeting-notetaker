# Speaker Review and Diarization

Meeting Note-Taker labels who spoke in a transcript so the summary and action items are easier to read. Speaker review is a fallback for moments when those labels are uncertain. It lets you connect transcript labels such as `Speaker A` or `Speaker 1` to the people who attended the meeting.

Speaker review does not appear for every meeting. The app only prompts for review when speaker labels are uncertain after processing.

## Why speaker review exists

Automatic diarization can usually separate voices, but it may not always know which person each voice belongs to. Review gives you a quick way to correct the meeting record without changing the original recording.

Common reasons a meeting may need review include:

- Several people have similar voices.
- People talk over one another.
- A participant joins late or speaks only briefly.
- Audio quality changes during the call.
- The app captures everyone else through one system-audio stream.

## When it appears

After a meeting finishes processing, open it from **Past Meetings**. If review is needed, a **Review speakers** panel appears near the top of the meeting detail page with a message that some speaker labels are uncertain.

If the app is confident enough about the speaker labels, this panel is not shown.

## How to map speakers

In the **Review speakers** panel:

1. Read the representative quotes for each speaker label.
2. Use the **Mapping for...** dropdown to choose the matching attendee.
3. If you cannot identify the speaker, leave or choose **Unknown**.
4. If the person is not in the attendee list, choose **Custom name** and enter a display name.
5. Click **Save mappings**.

Your saved mappings are used for that meeting's transcript display and related meeting outputs. If you are not sure who a speaker is, marking them as unknown is better than guessing.

## How mappings affect action owners

Action items may be assigned to owners based on who appeared to say the task. When you map a speaker label to an attendee, Meeting Note-Taker can use that mapping to improve action-owner names and emails.

For example, if `Speaker B` said "I'll send the draft by Friday" and you map `Speaker B` to Taylor, the action item owner can be shown as Taylor instead of an unknown speaker label.

Mappings help the app be more accurate, but they do not guarantee every action owner will be correct. Some tasks are assigned by context, explicit names in the conversation, or the summarization step. Always review important action items before sharing them.

## Limitations of system-audio diarization

Meeting Note-Taker records your microphone and the system audio from your computer. This keeps setup simple and works across meeting tools, but it has limits:

- Remote participants are captured together through the same system-audio stream.
- Overlapping speech can be hard to separate.
- Speaker labels may change if voices sound similar or audio quality is poor.
- The app may detect more or fewer speakers than were actually present.
- It may identify that different people spoke without knowing their real names.

Speaker review is designed to make these uncertain cases clear and correctable. It should improve the meeting notes, but it should not be treated as 100% diarization accuracy.
