import { DateTime, Duration, Effect, Layer, Match, Option, Redacted, Schema } from "effect";
import { HttpClientRequest } from "effect/http";
import type { HttpClientResponse, HttpClient } from "effect/http";
import { EmailAddressSchema, emailMailboxAddress } from "./email-address.js";
import type { EmailMailbox } from "./email-address.js";
import {
  EmailSenderCapabilitiesSchema,
  ownEmailSenderCapabilities,
  validateEmailCapabilities,
} from "./email-capabilities.js";
import type { EmailConfigurationError } from "./email-configuration-error.js";
import { emailHttpSenderLayer } from "./email-http-protocol.js";
import { EmailHttpCredentialSchema } from "./email-http-credential.js";
import { EmailDeliveryUnknown } from "./email-delivery-unknown.js";
import type { EmailSubmissionError } from "./email-errors.js";
import { readEmailHttpJson } from "./email-http-response.js";
import { formatEmailTagLabel } from "./email-message-metadata.js";
import { EmailInvalidMessage } from "./email-invalid-message.js";
import { EmailMessageIdSchema, EmailReceiptSchema } from "./email-message.js";
import type { EmailMessage, EmailMessageInput, EmailReceipt } from "./email-message.js";
import type { EmailSendOptionsInput } from "./email-preparation.js";
import { preflightEmailMessage } from "./email-preflight.js";
import { EmailRejected } from "./email-rejected.js";
import { partitionEmailSuppressions } from "./email-recipient-outcomes.js";
import { parseEmailPartialSuppressionReceipt } from "./email-suppression-receipt.js";
import { EmailSenderIdempotencySchema } from "./email-sender.js";
import type { EmailSubmission, EmailSender } from "./email-sender.js";
import { emailLayer } from "./email-service.js";
import type {
  Email,
  EmailDeliveryPolicy,
  EmailRetryObserver,
  EmailRetryRestriction,
} from "./email-service.js";

export const mailersendEmailCapabilities = ownEmailSenderCapabilities(
  EmailSenderCapabilitiesSchema.make({
    attachmentContentTypes: "ProviderSelected",
    attachments: true,
    headers: "Repeated",
    inlineAttachments: true,
    metadata: false,
    scheduling: true,
    tags: { asciiOnly: false, maxCount: 5 },
  }),
);

export interface MailersendEmailOptions {
  readonly apiKey: Redacted.Redacted;
}

const MailersendConfiguration = Schema.Struct({
  apiKey: EmailHttpCredentialSchema,
});

const formatMailersendMailbox = (mailbox: EmailMailbox) =>
  Schema.is(EmailAddressSchema)(mailbox)
    ? { email: mailbox }
    : { email: mailbox.address, name: mailbox.name };

const supportsMailersendScheduledInstant = (sendAt: DateTime.Utc, nowMillis: number): boolean => {
  const aheadMillis = DateTime.toEpochMillis(sendAt) - nowMillis;

  return (
    aheadMillis >= 0 &&
    aheadMillis <= Duration.toMillis(Duration.hours(72)) &&
    DateTime.formatIso(sendAt).length === 24
  );
};

const parseMessageId = Schema.decodeUnknownOption(EmailMessageIdSchema);

const parseWarnings = Schema.decodeUnknownEffect(
  Schema.Struct({
    warnings: Schema.optionalKey(
      Schema.NonEmptyArray(
        Schema.Struct({
          recipients: Schema.NonEmptyArray(Schema.Struct({ email: EmailAddressSchema })).check(
            Schema.isMaxLength(50),
          ),
          type: Schema.Literals(["SOME_SUPPRESSED", "ALL_SUPPRESSED"]),
        }),
      ).check(Schema.isMaxLength(1)),
    ),
  }),
);

const mailersendAcknowledgement = Effect.fnUntraced(function* mailersendAcknowledgement(
  response: HttpClientResponse.HttpClientResponse,
  message: EmailMessage,
): Effect.fn.Return<EmailReceipt, EmailDeliveryUnknown> {
  const invalid = () =>
    new EmailDeliveryUnknown({
      provider: "mailersend",
      reason: "invalid-response",
      status: response.status,
    });

  const messageId = parseMessageId(response.headers["x-message-id"]);

  const warnings =
    response.headers["content-type"]?.toLowerCase().includes("application/json") === true
      ? (yield* readEmailHttpJson(response, "mailersend").pipe(
          Effect.flatMap(parseWarnings),
          Effect.mapError(invalid),
        )).warnings
      : undefined;

  if (warnings === undefined) {
    if (Option.isNone(messageId)) {
      return yield* invalid();
    }

    return Object.freeze(
      EmailReceiptSchema.cases.Accepted.make({
        messageId: messageId.value,
        provider: "mailersend",
      }),
    );
  }

  const [warning] = warnings;

  const { accepted, suppressed } = yield* partitionEmailSuppressions(
    message,
    warning.recipients.map(({ email }) => email),
    "mailersend",
    response.status,
  );

  if (warning.type === "ALL_SUPPRESSED") {
    if (accepted.length !== 0 || response.headers["x-message-id"] !== undefined) {
      return yield* invalid();
    }

    const receipt = EmailReceiptSchema.cases.Suppressed.make({
      provider: "mailersend",
      suppressed,
    });

    Object.freeze(receipt.suppressed);

    return Object.freeze(receipt);
  }

  if (accepted.length === 0 || Option.isNone(messageId)) {
    return yield* invalid();
  }

  return yield* parseEmailPartialSuppressionReceipt(
    { accepted, suppressed },
    "mailersend",
    response.status,
    messageId.value,
  );
});

const classifyMailersendRejection = (
  status: number,
): Effect.Effect<never, EmailSubmissionError> => {
  if (status >= 500) {
    return Effect.fail(
      new EmailDeliveryUnknown({ provider: "mailersend", reason: "server-error", status }),
    );
  }

  const reason = Match.value(status).pipe(
    Match.when(
      (code) => code === 401 || code === 403,
      () => "authentication" as const,
    ),
    Match.when(
      (code) => code === 400 || code === 413 || code === 422,
      () => "invalid-message" as const,
    ),
    Match.when(429, () => "rate-limited" as const),
    Match.when(
      (code) => code === 404 || code === 405,
      () => "rejected" as const,
    ),
    Match.orElse(() => "unexpected-status" as const),
  );

  return reason === "unexpected-status"
    ? Effect.fail(new EmailDeliveryUnknown({ provider: "mailersend", reason, status }))
    : Effect.fail(new EmailRejected({ provider: "mailersend", reason, status }));
};

const validateMailersendEmail = Effect.fnUntraced(function* validateMailersendEmail(
  message: EmailMessage,
): Effect.fn.Return<void, EmailInvalidMessage> {
  yield* validateEmailCapabilities(message, mailersendEmailCapabilities);
  const issues = [];

  if (
    message.sendAt !== undefined &&
    !supportsMailersendScheduledInstant(message.sendAt, DateTime.toEpochMillis(yield* DateTime.now))
  ) {
    issues.push({
      path: "sendAt",
      problem:
        "MailerSend scheduling requires a UTC instant from now through 72 hours ahead, with a four-digit year",
    });
  }

  if ((message.replyTo?.length ?? 0) > 1) {
    issues.push({ path: "replyTo", problem: "MailerSend accepts one reply-to mailbox" });
  }

  for (const [path, recipients] of [
    ["cc", message.cc],
    ["bcc", message.bcc],
  ] as const) {
    if ((recipients?.length ?? 0) > 10) {
      issues.push({
        path,
        problem: "MailerSend accepts at most ten recipients in this field",
      });
    }
  }

  const recipients = [...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])];

  if (
    recipients.some(
      (mailbox) => !Schema.is(EmailAddressSchema)(mailbox) && /[;,]/u.test(mailbox.name ?? ""),
    )
  ) {
    issues.push({
      path: "to",
      problem: "MailerSend recipient names cannot contain commas or semicolons",
    });
  }

  if (
    new Set(recipients.map((mailbox) => emailMailboxAddress(mailbox).toLowerCase())).size !==
    recipients.length
  ) {
    issues.push({
      path: "to",
      problem: "MailerSend recipient addresses must be distinct for suppression evidence",
    });
  }

  if (message.headers?.some(({ name }) => !/^[A-Za-z0-9-]+$/u.test(name)) === true) {
    issues.push({
      path: "headers",
      problem: "MailerSend header names require alphanumeric characters or hyphens",
    });
  }

  if (
    message.tags?.some(
      ({ name, value }) => name.includes(":") || name.length + value.length + 1 > 191,
    ) === true
  ) {
    issues.push({
      path: "tags",
      problem: "MailerSend tags require name:value pairs up to 191 characters and colon-free names",
    });
  }

  if (
    [message.body.text, message.body.html].some(
      (body) => body !== undefined && new TextEncoder().encode(body).byteLength > 2 * 1024 * 1024,
    )
  ) {
    issues.push({
      path: "body",
      problem: "MailerSend body representations must each fit within two MiB of UTF-8",
    });
  }

  if (issues.length > 0) {
    return yield* new EmailInvalidMessage({ issues });
  }

  return undefined;
});

const mailersendPreflight = {
  capabilities: mailersendEmailCapabilities,
  idempotency: EmailSenderIdempotencySchema.cases.None.make({}),
  provider: "mailersend",
  validate: validateMailersendEmail,
};

export const preflightMailersendEmail = (
  message: EmailMessageInput,
  options?: EmailSendOptionsInput,
) => preflightEmailMessage(mailersendPreflight, message, options);

export const mailersendSenderLayer = (
  options: MailersendEmailOptions,
): Layer.Layer<EmailSender, EmailConfigurationError, HttpClient.HttpClient> =>
  emailHttpSenderLayer(MailersendConfiguration, options, (configuration) => {
    const request = Effect.fnUntraced(function* buildMailersendRequest(
      submission: EmailSubmission,
    ): Effect.fn.Return<HttpClientRequest.HttpClientRequest, EmailRejected> {
      const { message } = submission;
      const [replyTo] = message.replyTo ?? [];

      return yield* HttpClientRequest.post("https://api.mailersend.com/v1/email").pipe(
        HttpClientRequest.bearerToken(Redacted.value(configuration.apiKey)),
        HttpClientRequest.acceptJson,
        HttpClientRequest.bodyJson({
          attachments: message.attachments?.map((attachment) => ({
            content: attachment.contentBase64,
            disposition:
              attachment.disposition ??
              (attachment.contentId === undefined ? "attachment" : "inline"),
            filename: attachment.filename,
            id: attachment.contentId,
          })),
          bcc: message.bcc?.map(formatMailersendMailbox),
          cc: message.cc?.map(formatMailersendMailbox),
          from: formatMailersendMailbox(message.from),
          headers: message.headers,
          html: message.body.html,
          reply_to: replyTo === undefined ? undefined : formatMailersendMailbox(replyTo),
          send_at: message.sendAt === undefined ? undefined : DateTime.formatIso(message.sendAt),
          settings: { track_clicks: false, track_content: false, track_opens: false },
          subject: message.subject,
          tags: message.tags?.map(formatEmailTagLabel),
          text: message.body.text,
          to: message.to.map(formatMailersendMailbox),
        }),
        Effect.mapError(
          () => new EmailRejected({ provider: "mailersend", reason: "invalid-message" }),
        ),
      );
    });

    const respond = Effect.fnUntraced(function* readMailersendResponse(
      response: HttpClientResponse.HttpClientResponse,
      message: EmailMessage,
    ): Effect.fn.Return<EmailReceipt, EmailSubmissionError> {
      if (response.status !== 202) {
        return yield* classifyMailersendRejection(response.status);
      }

      return yield* mailersendAcknowledgement(response, message);
    });

    return {
      ...mailersendPreflight,
      request,
      respond,
      span: "MailerSend.submit",
    };
  });

export const mailersendEmailLayer = (
  options: MailersendEmailOptions,
  policy?: EmailDeliveryPolicy,
  observer?: EmailRetryObserver,
  restriction?: EmailRetryRestriction,
): Layer.Layer<Email, EmailConfigurationError, HttpClient.HttpClient> =>
  emailLayer(policy, observer, restriction).pipe(Layer.provide(mailersendSenderLayer(options)));
