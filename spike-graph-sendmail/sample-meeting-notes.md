# Sample meeting — Graph sendMail spike

## Summary

This is a fake meeting transcript attachment used to validate Microsoft Graph
`Mail.Send` with a file attachment from the signed-in user's Outlook mailbox.

## Key points

- Only `@factor1.com.au` recipients should receive automated notes in production.
- External invitees are filtered out before send.
- Slice 4 Teams delivery will replace this interim email path.

## Transcript

**[00:00] Joseph:** Let's confirm Graph permissions work on a dev machine.
**[00:15] David:** If this lands in Sent Items with the attachment, we're good.
**[00:30] Benjamin:** Remember to strip external domains from the To list.
