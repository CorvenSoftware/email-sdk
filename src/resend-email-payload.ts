import { DateTime } from "effect";
import { formatEmailMailbox } from "./email-address.js";
import { emailAttachmentMimeType } from "./email-attachment.js";
import type { EmailMessage } from "./email-message.js";

export const buildResendEmailPayload = (message: EmailMessage) => ({
  attachments: message.attachments?.map((attachment) => ({
    content: attachment.contentBase64,
    content_id: attachment.contentId,
    content_type: emailAttachmentMimeType(attachment),
    filename: attachment.filename,
  })),
  bcc: message.bcc?.map(formatEmailMailbox),
  cc: message.cc?.map(formatEmailMailbox),
  from: formatEmailMailbox(message.from),
  headers:
    message.headers === undefined
      ? undefined
      : Object.fromEntries(message.headers.map((header) => [header.name, header.value])),
  html: message.body.html,
  reply_to: message.replyTo?.map(formatEmailMailbox),
  scheduled_at: message.sendAt === undefined ? undefined : DateTime.formatIso(message.sendAt),
  subject: message.subject,
  tags: message.tags,
  text: message.body.text,
  to: message.to.map(formatEmailMailbox),
});
