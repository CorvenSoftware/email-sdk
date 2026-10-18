import { DateTime, Effect, Layer, Redacted, Schema } from "effect";
import type { HttpClient, HttpClientResponse } from "effect/http";
import { HttpClientRequest } from "effect/http";
import { EmailAddressSchema, formatEmailMailbox } from "./email-address.js";
import type { EmailMailbox } from "./email-address.js";
import {
  EmailSenderCapabilitiesSchema,
  ownEmailSenderCapabilities,
  validateEmailCapabilities,
} from "./email-capabilities.js";
import type { EmailConfigurationError } from "./email-configuration-error.js";
import { EmailDeliveryUnknown } from "./email-delivery-unknown.js";
import type { EmailSubmissionError } from "./email-errors.js";
import { EmailHttpCredentialTextSchema } from "./email-http-credential.js";
import { emailHttpSenderLayer } from "./email-http-protocol.js";
import { readEmailHttpJson } from "./email-http-response.js";
import { EmailInvalidMessage } from "./email-invalid-message.js";
import { EmailMessageIdSchema, EmailRecipientOutcomeSchema } from "./email-message.js";
import type { EmailMessage, EmailReceipt } from "./email-message.js";
import { EmailTagSchema, formatEmailTagLabel } from "./email-message-metadata.js";
import { emailRecipientAddresses } from "./email-recipient-outcomes.js";
import { parseEmailRecipientReceipt } from "./email-recipient-receipt.js";
import { EmailRejected } from "./email-rejected.js";
import { EmailSenderIdempotencySchema } from "./email-sender.js";
import type { EmailSender, EmailSubmission } from "./email-sender.js";
import { emailLayer } from "./email-service.js";
import type {
  Email,
  EmailDeliveryPolicy,
  EmailRetryObserver,
  EmailRetryRestriction,
} from "./email-service.js";

export const mailchimpEmailCapabilities = ownEmailSenderCapabilities(
  EmailSenderCapabilitiesSchema.make({
    attachmentContentTypes: "Explicit",
    attachments: true,
    headers: "Unique",
    inlineAttachments: true,
    metadata: true,
    scheduling: true,
    tags: { asciiOnly: false, maxCount: 0 },
  }),
);

const MailchimpStatisticsTag = EmailTagSchema.check(
  Schema.makeFilter(
    (tag) =>
      !tag.name.includes(":") &&
      !tag.name.startsWith("_") &&
      /^[^\uD800-\uDFFF]*$/u.test(formatEmailTagLabel(tag)) &&
      new TextEncoder().encode(formatEmailTagLabel(tag)).byteLength <= 50,
    {
      expected:
        "a well-formed Mailchimp name:value label of at most 50 UTF-8 bytes with a colon-free, non-reserved name",
    },
  ),
);

const MailchimpTagStatistics = Schema.Struct({
  authority: Schema.Literal("AuthorizeKnownAccountTagStatistics"),
  knownTags: Schema.NonEmptyArray(MailchimpStatisticsTag).check(
    Schema.isMaxLength(100),
    Schema.makeFilter(
      (tags) => {
        const labels = tags.map((tag) => formatEmailTagLabel(tag).toLowerCase());

        return new Set(labels).size === labels.length;
      },
      { expected: "distinct known account tag labels without case collisions" },
    ),
  ),
});

export type MailchimpTagStatisticsInput = typeof MailchimpTagStatistics.Encoded;

export interface MailchimpEmailOptions {
  readonly apiKey: Redacted.Redacted;
  readonly automaticFooter: "AccountDisabled";
  readonly keyMode: "Live";
  readonly messageRules: "AccountDisabled";
  readonly tagStatistics?: MailchimpTagStatisticsInput;
}

const MailchimpConfiguration = Schema.Struct({
  apiKey: Schema.Redacted(EmailHttpCredentialTextSchema.check(Schema.isMaxLength(256))),
  automaticFooter: Schema.Literal("AccountDisabled"),
  keyMode: Schema.Literal("Live"),
  messageRules: Schema.Literal("AccountDisabled"),
  tagStatistics: Schema.optionalKey(MailchimpTagStatistics),
});

const MailchimpRejectedReason = Schema.Literals([
  "hard-bounce",
  "soft-bounce",
  "spam",
  "unsub",
  "custom",
  "invalid-sender",
  "invalid",
  "test-mode-limit",
  "unsigned",
  "rule",
]);

const MailchimpQueuedReason = Schema.Literals([
  "attachments",
  "multiple-recipients",
  "free-trial-sends-exhausted",
  "hourly-quota-exhausted",
  "monthly-limit-reached",
  "sending-paused",
  "sending-suspended",
  "account-suspended",
  "sending-backlogged",
]);

const MailchimpRecipientResponse = Schema.Union([
  Schema.Struct({
    _id: EmailMessageIdSchema,
    email: EmailAddressSchema,
    queued_reason: Schema.optionalKey(Schema.Null),
    reject_reason: Schema.optionalKey(Schema.Null),
    status: Schema.Literals(["sent", "scheduled"]),
  }),
  Schema.Struct({
    _id: EmailMessageIdSchema,
    email: EmailAddressSchema,
    queued_reason: Schema.optionalKey(Schema.NullOr(MailchimpQueuedReason)),
    reject_reason: Schema.optionalKey(Schema.Null),
    status: Schema.Literal("queued"),
  }),
  Schema.Struct({
    _id: Schema.optionalKey(Schema.NullOr(EmailMessageIdSchema)),
    email: EmailAddressSchema,
    queued_reason: Schema.optionalKey(Schema.Null),
    reject_reason: Schema.optionalKey(Schema.NullOr(MailchimpRejectedReason)),
    status: Schema.Literals(["rejected", "invalid"]),
  }),
]);

const MailchimpAcknowledgement = Schema.NonEmptyArray(MailchimpRecipientResponse).check(
  Schema.isMaxLength(50),
);

const MailchimpProblem = Schema.Struct({
  _id: Schema.optionalKey(Schema.Null),
  code: Schema.Int,
  name: Schema.String.check(Schema.isMaxLength(128)),
  status: Schema.Literal("error"),
});

const mailchimpMailbox = (mailbox: EmailMailbox) =>
  Schema.is(EmailAddressSchema)(mailbox)
    ? { email: mailbox }
    : { email: mailbox.address, name: mailbox.name };

const buildMailchimpMessage = (message: EmailMessage) => {
  const [replyTo] = message.replyTo ?? [];

  const headers = Object.fromEntries(
    (message.headers ?? []).map(({ name, value }) => [name, value]),
  );

  if (replyTo !== undefined) {
    headers["Reply-To"] = formatEmailMailbox(replyTo);
  }

  const from = mailchimpMailbox(message.from);

  return {
    attachments: message.attachments
      ?.filter((attachment) => attachment.contentId === undefined)
      .map((attachment) => ({
        content: attachment.contentBase64,
        name: attachment.filename,
        type: attachment.contentType,
      })),
    auto_html: false,
    auto_text: false,
    bcc_address: null,
    from_email: from.email,
    from_name: Schema.is(EmailAddressSchema)(message.from) ? undefined : message.from.name,
    google_analytics_domains: [],
    headers,
    html: message.body.html,
    images: message.attachments
      ?.filter((attachment) => attachment.contentId !== undefined)
      .map((attachment) => ({
        content: attachment.contentBase64,
        name: attachment.contentId,
        type: attachment.contentType,
      })),
    important: false,
    inline_css: false,
    merge: false,
    metadata: message.metadata,
    preserve_recipients: true,
    subject: message.subject,
    tags: message.tags?.map(formatEmailTagLabel),
    text: message.body.text,
    to: [
      ...message.to.map((mailbox) => ({ ...mailchimpMailbox(mailbox), type: "to" })),
      ...(message.cc ?? []).map((mailbox) => ({ ...mailchimpMailbox(mailbox), type: "cc" })),
      ...(message.bcc ?? []).map((mailbox) => ({ ...mailchimpMailbox(mailbox), type: "bcc" })),
    ],
    track_clicks: false,
    track_opens: false,
    url_strip_qs: false,
    view_content_link: false,
  };
};

const buildMailchimpPayload = (message: EmailMessage) => ({
  async: false,
  message: buildMailchimpMessage(message),
  send_at:
    message.sendAt === undefined
      ? undefined
      : DateTime.formatIso(message.sendAt).slice(0, 19).replace("T", " "),
});

const classifyMailchimpRejection = Effect.fnUntraced(function* classifyMailchimpRejection(
  response: HttpClientResponse.HttpClientResponse,
): Effect.fn.Return<never, EmailSubmissionError> {
  const { status } = response;

  if (![401, 402].includes(status)) {
    return yield* new EmailDeliveryUnknown({
      provider: "mailchimp",
      reason: status >= 500 ? "server-error" : "unexpected-status",
      status,
    });
  }

  const problem = yield* readEmailHttpJson(response, "mailchimp").pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(MailchimpProblem)),
    Effect.mapError(
      () => new EmailDeliveryUnknown({ provider: "mailchimp", reason: "invalid-response", status }),
    ),
  );

  if (status === 401 && problem.code === 401 && problem.name === "Invalid_Key") {
    return yield* new EmailRejected({ provider: "mailchimp", reason: "authentication", status });
  }

  if (status === 402 && problem.code === 10 && problem.name === "PaymentRequired") {
    return yield* new EmailRejected({ provider: "mailchimp", reason: "rejected", status });
  }

  return yield* new EmailDeliveryUnknown({
    provider: "mailchimp",
    reason: "invalid-response",
    status,
  });
});

export const mailchimpSenderLayer = (
  options: MailchimpEmailOptions,
): Layer.Layer<EmailSender, EmailConfigurationError, HttpClient.HttpClient> =>
  emailHttpSenderLayer(MailchimpConfiguration, options, (configuration) => {
    const knownTagLabels = new Set(configuration.tagStatistics?.knownTags.map(formatEmailTagLabel));

    const approvedTags = Schema.UndefinedOr(
      Schema.NonEmptyArray(MailchimpStatisticsTag).check(
        Schema.makeFilter(
          (tags) => tags.every((tag) => knownTagLabels.has(formatEmailTagLabel(tag))),
          { expected: "only explicitly known account tag labels" },
        ),
      ),
    );

    const capabilities =
      knownTagLabels.size === 0
        ? mailchimpEmailCapabilities
        : ownEmailSenderCapabilities({
            ...mailchimpEmailCapabilities,
            tags: {
              asciiOnly: false,
              maxCount: Math.min(
                75,
                new Set(configuration.tagStatistics?.knownTags.map((tag) => tag.name)).size,
              ),
            },
          });

    const validate = Effect.fnUntraced(function* validateMailchimpIntent(
      message: EmailMessage,
    ): Effect.fn.Return<void, EmailInvalidMessage> {
      yield* validateEmailCapabilities(message, capabilities);
      const issues: string[] = [];
      const addresses = emailRecipientAddresses(message).map((address) => address.toLowerCase());

      if (message.sendAt !== undefined) {
        const scheduled = DateTime.toEpochMillis(message.sendAt);
        const delta = scheduled - DateTime.toEpochMillis(yield* DateTime.now);

        if (
          scheduled % 1000 !== 0 ||
          delta <= 0 ||
          delta > 365 * 24 * 60 * 60 * 1000 ||
          DateTime.formatIso(message.sendAt).length !== 24
        ) {
          issues.push("sendAt");
        }
      }

      if (new Set(addresses).size !== addresses.length) {
        issues.push("to");
      }

      if (message.replyTo !== undefined && message.replyTo.length !== 1) {
        issues.push("replyTo");
      }

      if (
        message.headers?.some(
          ({ name }) =>
            name.toLowerCase().startsWith("x-mc-") || name.toLowerCase().startsWith("x-mandrill-"),
        ) === true
      ) {
        issues.push("headers");
      }

      if (!Schema.is(approvedTags)(message.tags)) {
        issues.push("tags");
      }

      if (
        message.metadata !== undefined &&
        (new TextEncoder().encode(JSON.stringify(message.metadata)).byteLength >= 250 ||
          Object.keys(message.metadata).some((name) => !/^[A-Za-z0-9][A-Za-z0-9_]*$/u.test(name)))
      ) {
        issues.push("metadata");
      }

      if (
        message.attachments?.some(
          (attachment) =>
            attachment.contentId !== undefined &&
            (!attachment.contentType.startsWith("image/") ||
              String(attachment.contentId) !== String(attachment.filename)),
        ) === true
      ) {
        issues.push("attachments");
      }

      if (
        [message.body.html, message.body.text].some(
          (body) => body !== undefined && /\*\|UNSUB:/iu.test(body),
        )
      ) {
        issues.push("body");
      }

      if (
        new TextEncoder().encode(JSON.stringify(buildMailchimpPayload(message))).byteLength >
        9_999_000
      ) {
        issues.push("body");
      }

      if (issues.length > 0) {
        return yield* new EmailInvalidMessage({
          issues: [...new Set(issues)].map((path) => ({
            path,
            problem:
              path === "sendAt"
                ? "Mailchimp scheduling requires a future whole UTC second within 365 days and a four-digit year"
                : "Mailchimp cannot preserve this transactional intent",
          })),
        });
      }

      return undefined;
    });

    const request = Effect.fnUntraced(function* buildMailchimpRequest(
      submission: EmailSubmission,
    ): Effect.fn.Return<HttpClientRequest.HttpClientRequest, EmailRejected> {
      return yield* HttpClientRequest.post("https://mandrillapp.com/api/1.4/messages/send").pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.bodyJson({
          ...buildMailchimpPayload(submission.message),
          key: Redacted.value(configuration.apiKey),
        }),
        Effect.mapError(
          () => new EmailRejected({ provider: "mailchimp", reason: "invalid-message" }),
        ),
      );
    });

    const respond = Effect.fnUntraced(function* parseMailchimpAcknowledgement(
      response: HttpClientResponse.HttpClientResponse,
      message: EmailMessage,
    ): Effect.fn.Return<EmailReceipt, EmailSubmissionError> {
      if (response.status !== 200) {
        return yield* classifyMailchimpRejection(response);
      }

      const records = yield* readEmailHttpJson(response, "mailchimp").pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(MailchimpAcknowledgement)),
        Effect.mapError(
          () =>
            new EmailDeliveryUnknown({
              provider: "mailchimp",
              reason: "invalid-response",
              status: response.status,
            }),
        ),
      );

      const acceptedStatuses = message.sendAt === undefined ? ["sent", "queued"] : ["scheduled"];

      if (
        records.some(
          ({ status }) =>
            status !== "rejected" && status !== "invalid" && !acceptedStatuses.includes(status),
        )
      ) {
        return yield* new EmailDeliveryUnknown({
          provider: "mailchimp",
          reason: "invalid-response",
          status: response.status,
        });
      }

      const outcomes = records.map((record) => {
        if (
          record.status === "sent" ||
          record.status === "queued" ||
          record.status === "scheduled"
        ) {
          return EmailRecipientOutcomeSchema.cases.Accepted.make({
            messageId: record._id,
            recipient: record.email,
          });
        }

        if (record._id !== undefined && record._id !== null) {
          return EmailRecipientOutcomeSchema.cases.Rejected.make({
            messageId: record._id,
            recipient: record.email,
          });
        }

        return EmailRecipientOutcomeSchema.cases.Rejected.make({ recipient: record.email });
      });

      return yield* parseEmailRecipientReceipt(message, outcomes, "mailchimp", response.status);
    });

    return {
      capabilities,
      idempotency: EmailSenderIdempotencySchema.cases.None.make({}),
      provider: "mailchimp",
      request,
      respond,
      span: "Mailchimp.submit",
      validate,
    };
  });

export const mailchimpEmailLayer = (
  options: MailchimpEmailOptions,
  policy?: EmailDeliveryPolicy,
  observer?: EmailRetryObserver,
  restriction?: EmailRetryRestriction,
): Layer.Layer<Email, EmailConfigurationError, HttpClient.HttpClient> =>
  emailLayer(policy, observer, restriction).pipe(Layer.provide(mailchimpSenderLayer(options)));
