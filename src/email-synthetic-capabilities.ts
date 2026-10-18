import { EmailSenderCapabilitiesSchema, ownEmailSenderCapabilities } from "./email-capabilities.js";

export const syntheticEmailCapabilities = ownEmailSenderCapabilities(
  EmailSenderCapabilitiesSchema.make({
    attachmentContentTypes: "Both",
    attachments: true,
    headers: "Repeated",
    inlineAttachments: true,
    metadata: true,
    scheduling: true,
    tags: { asciiOnly: false, maxCount: 75 },
  }),
);
