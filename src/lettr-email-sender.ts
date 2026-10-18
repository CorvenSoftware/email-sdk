import { DateTime, Duration, Effect, Layer, Option, Schema } from "effect";
import { HttpClientRequest } from "effect/http";
import type { HttpClient, HttpClientResponse } from "effect/http";
import { EmailAddressSchema, emailMailboxAddress } from "./email-address.js";
import type { EmailMailbox } from "./email-address.js";
import {
  EmailSenderCapabilitiesSchema,
  ownEmailSenderCapabilities,
  validateEmailCapabilities,
} from "./email-capabilities.js";
import type { EmailConfigurationError } from "./email-configuration-error.js";
import { EmailDeliveryUnknown } from "./email-delivery-unknown.js";
import { parseEmailCountedReceipt } from "./email-counted-receipt.js";
import type { EmailSubmissionError } from "./email-errors.js";
import { EmailHttpCredentialTextSchema } from "./email-http-credential.js";
import { emailHttpSenderLayer } from "./email-http-protocol.js";
import { readEmailHttpJson } from "./email-http-response.js";
import { parseEmailHttpRetryAfterMillis } from "./email-http-retry-after.js";
import { EmailInvalidMessage } from "./email-invalid-message.js";
import { EmailMessageIdSchema, EmailReceiptSchema } from "./email-message.js";
import type { EmailMessage, EmailReceipt } from "./email-message.js";
import { EmailSendAtSchema, formatEmailTagLabel } from "./email-message-metadata.js";
import {
  EmailRecipientCountsSchema,
  emailRecipientAddresses,
  parseEmailRecipientCounts,
} from "./email-recipient-outcomes.js";
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
import type { Redacted } from "effect";

export const lettrEmailCapabilities = ownEmailSenderCapabilities(
  EmailSenderCapabilitiesSchema.make({
    attachmentContentTypes: "Explicit",
    attachments: true,
    headers: "Unique",
    inlineAttachments: false,
    metadata: true,
    scheduling: false,
    tags: { asciiOnly: false, maxCount: 1 },
  }),
);

export const lettrScheduledEmailCapabilities = ownEmailSenderCapabilities(
  EmailSenderCapabilitiesSchema.make({ ...lettrEmailCapabilities, scheduling: true }),
);

export interface LettrEmailOptions {
  readonly apiKey: Redacted.Redacted;
  readonly submissionMode: "Immediate" | "Scheduled";
}

const LettrConfiguration = Schema.Struct({
  apiKey: Schema.Redacted(
    EmailHttpCredentialTextSchema.check(
      Schema.isPattern(/^lttr_(?!sandbox_).+$/u, {
        expected:
          "a live Lettr submission credential; sandbox recipient rewriting is not supported",
      }),
    ),
  ),
  submissionMode: Schema.Literals(["Immediate", "Scheduled"]),
});

const LettrAcknowledgement = Schema.Struct({
  data: Schema.Struct({
    accepted: EmailRecipientCountsSchema.fields.acceptedCount,
    rejected: EmailRecipientCountsSchema.fields.rejectedCount,
    request_id: EmailMessageIdSchema,
  }),
  error_code: Schema.optionalKey(Schema.Null),
});

const LettrScheduledAcknowledgement = Schema.Struct({
  data: Schema.Struct({
    accepted: EmailRecipientCountsSchema.fields.acceptedCount,
    failure_reason: Schema.Null,
    num_recipients: Schema.Int.check(Schema.isBetween({ maximum: 50, minimum: 1 })),
    recipients: Schema.NonEmptyArray(EmailAddressSchema).check(Schema.isMaxLength(50)),
    rejected: EmailRecipientCountsSchema.fields.rejectedCount,
    request_id: EmailMessageIdSchema.check(Schema.isPattern(/^sch_.+$/u)),
    scheduled_at: Schema.String,
    state: Schema.Literal("scheduled"),
    transmission_id: Schema.Null,
  }),
  error_code: Schema.optionalKey(Schema.Null),
});

const LettrErrorResponse = Schema.Struct({
  data: Schema.optionalKey(Schema.Null),
  error_code: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  request_id: Schema.optionalKey(Schema.Null),
  status: Schema.optionalKey(Schema.Literal("error")),
});

const lettrMailboxName = (mailbox: EmailMailbox) =>
  Schema.is(EmailAddressSchema)(mailbox) ? undefined : mailbox.name;

const supportsLettrReplyTo = (replyTo: EmailMessage["replyTo"]): boolean =>
  replyTo === undefined ||
  (replyTo.length === 1 && (lettrMailboxName(replyTo[0])?.length ?? 0) <= 255);

const supportsLettrScheduledInstant = (sendAt: DateTime.Utc, nowMillis: number): boolean => {
  const aheadMillis = DateTime.toEpochMillis(sendAt) - nowMillis;

  return (
    aheadMillis >= Duration.toMillis(Duration.minutes(5)) &&
    aheadMillis <= Duration.toMillis(Duration.days(30)) &&
    DateTime.formatIso(sendAt).length === 24
  );
};

const lettrDelayedRejection = (
  response: HttpClientResponse.HttpClientResponse,
  reason: "rate-limited" | "temporarily-unavailable",
) =>
  Option.match(parseEmailHttpRetryAfterMillis(response.headers["retry-after"]), {
    onNone: () => new EmailRejected({ provider: "lettr", reason, status: response.status }),
    onSome: (retryAfterMillis) =>
      new EmailRejected({ provider: "lettr", reason, retryAfterMillis, status: response.status }),
  });

const lettrClientRejectionReason = (status: number, code: string) => {
  if (
    status === 400 &&
    ["invalid_domain", "unconfigured_domain", "send_error", "retrieval_error"].includes(code)
  ) {
    return "rejected";
  }

  if (status === 403 && code === "insufficient_scope") {
    return "rejected";
  }

  if (status === 404 && code === "template_not_found") {
    return "rejected";
  }

  if (status === 422 && code === "validation_error") {
    return "invalid-message";
  }

  return "unexpected-status";
};

const isLettrReservedHeader = (name: string): boolean =>
  ["message-id", "list-unsubscribe", "list-unsubscribe-post", "x-msys-api"].includes(
    name.toLowerCase(),
  ) || name.toLowerCase().startsWith("x-lettr-");

const classifyLettrRejection = Effect.fnUntraced(function* classifyLettrRejection(
  response: HttpClientResponse.HttpClientResponse,
): Effect.fn.Return<never, EmailSubmissionError> {
  const { status } = response;

  if (status === 401) {
    return yield* new EmailRejected({ provider: "lettr", reason: "authentication", status });
  }

  const problem = yield* readEmailHttpJson(response, "lettr").pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(LettrErrorResponse)),
    Effect.option,
  );

  const code = Option.isSome(problem) ? problem.value.error_code : "unclassified";

  if (status === 503 && code === "auth_unavailable") {
    return yield* lettrDelayedRejection(response, "temporarily-unavailable");
  }

  if (status >= 500) {
    return yield* new EmailDeliveryUnknown({ provider: "lettr", reason: "server-error", status });
  }

  if (status === 409) {
    if (code === "idempotency_key_conflict") {
      return yield* new EmailRejected({
        provider: "lettr",
        reason: "idempotency-conflict",
        status,
      });
    }

    if (code === "idempotency_in_progress") {
      return yield* Option.match(parseEmailHttpRetryAfterMillis(response.headers["retry-after"]), {
        onNone: () =>
          new EmailDeliveryUnknown({
            provider: "lettr",
            reason: "idempotency-in-progress",
            status,
          }),
        onSome: (retryAfterMillis) =>
          new EmailDeliveryUnknown({
            provider: "lettr",
            reason: "idempotency-in-progress",
            retryAfterMillis,
            status,
          }),
      });
    }

    return yield* new EmailDeliveryUnknown({
      provider: "lettr",
      reason: "unexpected-status",
      status,
    });
  }

  if (status === 429) {
    if (Option.isNone(problem)) {
      return yield* new EmailDeliveryUnknown({
        provider: "lettr",
        reason: "invalid-response",
        status,
      });
    }

    if (code === "rate_limit_exceeded") {
      return yield* lettrDelayedRejection(response, "rate-limited");
    }

    return yield* new EmailRejected({ provider: "lettr", reason: "rejected", status });
  }

  const reason = lettrClientRejectionReason(status, code);

  if (reason !== "unexpected-status") {
    return yield* new EmailRejected({ provider: "lettr", reason, status });
  }

  return yield* new EmailDeliveryUnknown({
    provider: "lettr",
    reason: "unexpected-status",
    status,
  });
});

const readLettrImmediateReceipt = Effect.fnUntraced(function* readLettrImmediateReceipt(
  response: HttpClientResponse.HttpClientResponse,
  message: EmailMessage,
): Effect.fn.Return<EmailReceipt, EmailDeliveryUnknown> {
  const invalid = () =>
    new EmailDeliveryUnknown({
      provider: "lettr",
      reason: "invalid-response",
      status: response.status,
    });

  const body = yield* readEmailHttpJson(response, "lettr").pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(LettrAcknowledgement)),
    Effect.mapError(invalid),
  );

  return yield* parseEmailCountedReceipt(
    message,
    { acceptedCount: body.data.accepted, rejectedCount: body.data.rejected },
    "lettr",
    response.status,
    body.data.request_id,
  );
});

const readLettrScheduledReceipt = Effect.fnUntraced(function* readLettrScheduledReceipt(
  response: HttpClientResponse.HttpClientResponse,
  message: EmailMessage,
): Effect.fn.Return<EmailReceipt, EmailDeliveryUnknown> {
  const invalid = () =>
    new EmailDeliveryUnknown({
      provider: "lettr",
      reason: "invalid-response",
      status: response.status,
    });

  const body = yield* readEmailHttpJson(response, "lettr").pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(LettrScheduledAcknowledgement)),
    Effect.mapError(invalid),
  );

  const { data } = body;

  const counts = yield* parseEmailRecipientCounts(
    message,
    { acceptedCount: data.accepted, rejectedCount: data.rejected },
    "lettr",
    response.status,
  );

  const requested = emailRecipientAddresses(message);
  const recipientSet = new Set(data.recipients.map((address) => address.toLowerCase()));

  const scheduledAt = Schema.decodeOption(EmailSendAtSchema)(
    data.scheduled_at.replace(/\+00:00$/u, "Z"),
  );

  if (
    counts.rejectedCount !== 0 ||
    data.num_recipients !== requested.length ||
    data.recipients.length !== requested.length ||
    recipientSet.size !== requested.length ||
    !requested.every((address) => recipientSet.has(address.toLowerCase())) ||
    message.sendAt === undefined ||
    Option.isNone(scheduledAt) ||
    DateTime.toEpochMillis(scheduledAt.value) !== DateTime.toEpochMillis(message.sendAt)
  ) {
    return yield* invalid();
  }

  return Object.freeze(
    EmailReceiptSchema.cases.Accepted.make({ messageId: data.request_id, provider: "lettr" }),
  );
});

export const lettrSenderLayer = (
  options: LettrEmailOptions,
): Layer.Layer<EmailSender, EmailConfigurationError, HttpClient.HttpClient> =>
  emailHttpSenderLayer(LettrConfiguration, options, (configuration) => {
    const scheduled = configuration.submissionMode === "Scheduled";
    const capabilities = scheduled ? lettrScheduledEmailCapabilities : lettrEmailCapabilities;

    const validate = Effect.fnUntraced(function* validateLettrIntent(
      message: EmailMessage,
    ): Effect.fn.Return<void, EmailInvalidMessage> {
      yield* validateEmailCapabilities(message, capabilities);
      const issues: string[] = [];

      if (scheduled && message.sendAt === undefined) {
        issues.push("sendAt");
      }

      if (
        message.sendAt !== undefined &&
        !supportsLettrScheduledInstant(message.sendAt, DateTime.toEpochMillis(yield* DateTime.now))
      ) {
        issues.push("sendAt");
      }

      if (lettrMailboxName(message.from)?.length === 256) {
        issues.push("from");
      }

      if (!supportsLettrReplyTo(message.replyTo)) {
        issues.push("replyTo");
      }

      if (
        [...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])].some(
          (mailbox) => lettrMailboxName(mailbox) !== undefined,
        )
      ) {
        issues.push("to");
      }

      const requested = emailRecipientAddresses(message);

      if (new Set(requested.map((address) => address.toLowerCase())).size !== requested.length) {
        issues.push("to");
      }

      if (
        message.tags?.some(
          ({ name, value }) => name.includes(":") || name.length + value.length + 1 > 64,
        ) === true
      ) {
        issues.push("tags");
      }

      if (
        (message.headers?.length ?? 0) > 10 ||
        message.headers?.some(({ name }) => isLettrReservedHeader(name)) === true
      ) {
        issues.push("headers");
      }

      if (issues.length > 0) {
        return yield* new EmailInvalidMessage({
          issues: issues.map((path) => ({
            path,
            problem:
              path === "sendAt"
                ? "Lettr scheduling requires a UTC instant at least five minutes and at most 30 days ahead, with a four-digit year"
                : "Lettr cannot preserve this intent in the selected submission mode",
          })),
        });
      }

      return undefined;
    });

    const request = Effect.fnUntraced(function* buildLettrRequest(
      submission: EmailSubmission,
    ): Effect.fn.Return<HttpClientRequest.HttpClientRequest, EmailRejected> {
      const { message } = submission;

      const unkeyed = yield* HttpClientRequest.post(
        scheduled
          ? "https://app.lettr.com/api/emails/scheduled"
          : "https://app.lettr.com/api/emails",
      ).pipe(
        HttpClientRequest.bearerToken(configuration.apiKey),
        HttpClientRequest.acceptJson,
        HttpClientRequest.bodyJson({
          attachments: message.attachments?.map(({ contentBase64, contentType, filename }) => ({
            data: contentBase64,
            name: filename,
            type: contentType,
          })),
          bcc: message.bcc?.map(emailMailboxAddress),
          cc: message.cc?.map(emailMailboxAddress),
          from: emailMailboxAddress(message.from),
          from_name: lettrMailboxName(message.from),
          headers:
            message.headers === undefined
              ? undefined
              : Object.fromEntries(message.headers.map(({ name, value }) => [name, value])),
          html: message.body.html,
          metadata: message.metadata,
          options: {
            click_tracking: false,
            inline_css: false,
            open_tracking: false,
            perform_substitutions: false,
            transactional: false,
          },
          reply_to:
            message.replyTo === undefined ? undefined : emailMailboxAddress(message.replyTo[0]),
          reply_to_name:
            message.replyTo === undefined ? undefined : lettrMailboxName(message.replyTo[0]),
          scheduled_at:
            message.sendAt === undefined ? undefined : DateTime.formatIso(message.sendAt),
          subject: message.subject,
          tag: message.tags?.map(formatEmailTagLabel)[0],
          text: message.body.text,
          to: message.to.map(emailMailboxAddress),
        }),
        Effect.mapError(() => new EmailRejected({ provider: "lettr", reason: "invalid-message" })),
      );

      return submission.idempotencyKey === undefined
        ? unkeyed
        : HttpClientRequest.setHeader(unkeyed, "Idempotency-Key", submission.idempotencyKey);
    });

    const respond = Effect.fnUntraced(function* readLettrAcknowledgement(
      response: HttpClientResponse.HttpClientResponse,
      message: EmailMessage,
    ): Effect.fn.Return<EmailReceipt, EmailSubmissionError> {
      if (response.status !== (scheduled ? 201 : 200)) {
        return yield* classifyLettrRejection(response);
      }

      return yield* scheduled
        ? readLettrScheduledReceipt(response, message)
        : readLettrImmediateReceipt(response, message);
    });

    return {
      capabilities,
      idempotency: scheduled
        ? EmailSenderIdempotencySchema.cases.None.make({})
        : EmailSenderIdempotencySchema.cases.Native.make({
            keyFormat: "AlphanumericDotUnderscoreHyphen",
            maxKeyLength: 255,
            retention: Duration.hours(24),
          }),
      provider: "lettr",
      request,
      respond,
      span: "Lettr.submit",
      validate,
    };
  });

export const lettrEmailLayer = (
  options: LettrEmailOptions,
  policy?: EmailDeliveryPolicy,
  observer?: EmailRetryObserver,
  restriction?: EmailRetryRestriction,
): Layer.Layer<Email, EmailConfigurationError, HttpClient.HttpClient> =>
  emailLayer(policy, observer, restriction).pipe(Layer.provide(lettrSenderLayer(options)));
