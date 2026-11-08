import { Effect, Schema } from "effect";
import { EmailInvalidMessage } from "./email-invalid-message.js";
import type { EmailInputIssue } from "./email-input-issues.js";
import type { EmailMessage } from "./email-message.js";

export const EmailSenderCapabilitiesSchema = Schema.Struct({
  attachmentContentTypes: Schema.Literals(["None", "Explicit", "ProviderSelected", "Both"]),
  attachments: Schema.Boolean,
  headers: Schema.Literals(["None", "Unique", "Repeated"]),
  inlineAttachments: Schema.Boolean,
  metadata: Schema.Boolean,
  scheduling: Schema.Boolean,
  tags: Schema.Struct({
    asciiOnly: Schema.Boolean,
    maxCount: Schema.Int.check(Schema.isBetween({ maximum: 75, minimum: 0 })),
  }),
}).check(
  Schema.makeFilter(
    (capabilities) => capabilities.attachments === (capabilities.attachmentContentTypes !== "None"),
    {
      expected: "attachment support consistent with MIME selection authority",
    },
  ),
  Schema.makeFilter((capabilities) => !capabilities.inlineAttachments || capabilities.attachments, {
    expected: "attachment support when inline attachments are supported",
  }),
);

export type EmailSenderCapabilities = typeof EmailSenderCapabilitiesSchema.Type;

export const ownEmailSenderCapabilities = (
  capabilities: EmailSenderCapabilities,
): EmailSenderCapabilities =>
  Object.freeze({
    ...capabilities,
    tags: Object.freeze({ ...capabilities.tags }),
  });

const emailHeaderIntersection = {
  None: { None: "None", Repeated: "None", Unique: "None" },
  Repeated: { None: "None", Repeated: "Repeated", Unique: "Unique" },
  Unique: { None: "None", Repeated: "Unique", Unique: "Unique" },
} as const satisfies Record<
  EmailSenderCapabilities["headers"],
  Record<EmailSenderCapabilities["headers"], EmailSenderCapabilities["headers"]>
>;

const emailAttachmentContentTypeIntersection = {
  Both: { Both: "Both", Explicit: "Explicit", None: "None", ProviderSelected: "ProviderSelected" },
  Explicit: { Both: "Explicit", Explicit: "Explicit", None: "None", ProviderSelected: "None" },
  None: { Both: "None", Explicit: "None", None: "None", ProviderSelected: "None" },
  ProviderSelected: {
    Both: "ProviderSelected",
    Explicit: "None",
    None: "None",
    ProviderSelected: "ProviderSelected",
  },
} as const satisfies Record<
  EmailSenderCapabilities["attachmentContentTypes"],
  Record<
    EmailSenderCapabilities["attachmentContentTypes"],
    EmailSenderCapabilities["attachmentContentTypes"]
  >
>;

export const intersectEmailSenderCapabilities = (
  capabilities: readonly [EmailSenderCapabilities, ...EmailSenderCapabilities[]],
): EmailSenderCapabilities => {
  const [primary, ...fallbacks] = capabilities;
  let shared = primary;

  for (const next of fallbacks) {
    const headers = emailHeaderIntersection[shared.headers][next.headers];

    const attachmentContentTypes =
      emailAttachmentContentTypeIntersection[shared.attachmentContentTypes][
        next.attachmentContentTypes
      ];

    const attachments = attachmentContentTypes !== "None";
    shared = {
      attachmentContentTypes,
      attachments,
      headers,
      inlineAttachments: attachments && shared.inlineAttachments && next.inlineAttachments,
      metadata: shared.metadata && next.metadata,
      scheduling: shared.scheduling && next.scheduling,
      tags: {
        asciiOnly: shared.tags.asciiOnly || next.tags.asciiOnly,
        maxCount: Math.min(shared.tags.maxCount, next.tags.maxCount),
      },
    };
  }

  return ownEmailSenderCapabilities(shared);
};

const emailAttachmentCapabilityIssues = (
  attachments: EmailMessage["attachments"],
  capabilities: EmailSenderCapabilities,
): readonly EmailInputIssue[] => {
  const issues: EmailInputIssue[] = [];

  if (attachments !== undefined && !capabilities.attachments) {
    issues.push({ path: "attachments", problem: "Provider does not support attachments" });
  }

  for (const [index, attachment] of (attachments ?? []).entries()) {
    if (
      (attachment.contentType === "ProviderSelected" &&
        capabilities.attachmentContentTypes === "Explicit") ||
      (attachment.contentType !== "ProviderSelected" &&
        capabilities.attachmentContentTypes === "ProviderSelected")
    ) {
      issues.push({
        path: `attachments.${index}.contentType`,
        problem: "Provider cannot preserve the selected MIME authority",
      });
    }
  }

  if (
    attachments?.some((attachment) => attachment.contentId !== undefined) === true &&
    !capabilities.inlineAttachments
  ) {
    issues.push({ path: "attachments", problem: "Provider does not support inline attachments" });
  }

  return issues;
};

export const validateEmailCapabilities = Effect.fnUntraced(function* validateEmailCapabilities(
  message: EmailMessage,
  capabilities: EmailSenderCapabilities,
): Effect.fn.Return<void, EmailInvalidMessage> {
  const issues: EmailInputIssue[] = [
    ...emailAttachmentCapabilityIssues(message.attachments, capabilities),
  ];

  if (message.headers !== undefined) {
    if (capabilities.headers === "None") {
      issues.push({ path: "headers", problem: "Provider does not support custom headers" });
    } else if (
      capabilities.headers === "Unique" &&
      new Set(message.headers.map((header) => header.name.toLowerCase())).size !==
        message.headers.length
    ) {
      issues.push({ path: "headers", problem: "Provider does not support repeated header names" });
    }
  }

  if (message.metadata !== undefined && !capabilities.metadata) {
    issues.push({ path: "metadata", problem: "Provider does not support message metadata" });
  }

  if (message.sendAt !== undefined && !capabilities.scheduling) {
    issues.push({ path: "sendAt", problem: "Provider does not support scheduling" });
  }

  if (message.tags !== undefined) {
    if (message.tags.length > capabilities.tags.maxCount) {
      issues.push({ path: "tags", problem: "Tag count exceeds provider support" });
    }

    if (
      capabilities.tags.asciiOnly &&
      message.tags.some(
        (tag) => !/^[A-Za-z0-9_-]+$/u.test(tag.name) || !/^[A-Za-z0-9_-]+$/u.test(tag.value),
      )
    ) {
      issues.push({
        path: "tags",
        problem: "Provider tags require ASCII letters, digits, underscores, or hyphens",
      });
    }
  }

  if (issues.length > 0) {
    return yield* new EmailInvalidMessage({ issues });
  }

  return undefined;
});
