import { DateTime, Duration, Effect, Match, Redacted, Schema } from "effect";
import type { HttpClientResponse } from "effect/http";
import { HttpClientRequest } from "effect/http";
import { defineEmailHttpProvider } from "./email-provider.js";
import { EmailHttpCredentialSchema } from "./email-http-credential.js";
import { EmailSenderCapabilitiesSchema, ownEmailSenderCapabilities } from "./email-capabilities.js";
import { formatEmailMailbox } from "./email-address.js";
import { emailAttachmentMimeType } from "./email-attachment.js";
import { EmailDeliveryUnknown } from "./email-delivery-unknown.js";
import { EmailInvalidMessage } from "./email-invalid-message.js";
import { EmailRejected } from "./email-rejected.js";
import { readEmailHttpJson } from "./email-http-response.js";
import { parseEmailHttpRetryAfterMillis } from "./email-http-retry-after.js";
import type { EmailSubmissionError } from "./email-errors.js";
import { EmailMessageIdSchema, EmailReceiptSchema } from "./email-message.js";
import type { EmailReceipt } from "./email-message.js";
import { EmailSenderIdempotencySchema } from "./email-sender.js";
import type { EmailSubmission } from "./email-sender.js";

export const resendEmailCapabilities = ownEmailSenderCapabilities(
  EmailSenderCapabilitiesSchema.make({
    attachmentContentTypes: "Both",
    attachments: true,
    headers: "Unique",
    inlineAttachments: true,
    metadata: false,
    scheduling: true,
    tags: Object.freeze({ asciiOnly: true, maxCount: 75 }),
  }),
);

export interface ResendEmailOptions {
  readonly apiKey: Redacted.Redacted;
}

const ResendConfiguration = Schema.Struct({
  apiKey: EmailHttpCredentialSchema,
});

const supportsResendScheduledInstant = (sendAt: DateTime.Utc, nowMillis: number): boolean => {
  const aheadMillis = DateTime.toEpochMillis(sendAt) - nowMillis;

  return (
    aheadMillis > 0 &&
    aheadMillis <= Duration.toMillis(Duration.days(30)) &&
    DateTime.formatIso(sendAt).length === 24
  );
};

const ResendAcknowledgement = Schema.Struct({ id: EmailMessageIdSchema });

const ResendError = Schema.Struct({ name: Schema.String });

const readErrorName = (response: HttpClientResponse.HttpClientResponse) =>
  readEmailHttpJson(response, "resend").pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(ResendError)),
    Effect.map((body) => body.name),
    Effect.orElseSucceed(() => "unclassified"),
  );

const classifyRejection = Effect.fnUntraced(function* classifyResendRejection(
  response: HttpClientResponse.HttpClientResponse,
): Effect.fn.Return<never, EmailSubmissionError> {
  const { status } = response;

  if (status >= 500) {
    return yield* new EmailDeliveryUnknown({ provider: "resend", reason: "server-error", status });
  }

  const name = yield* readErrorName(response);

  if (status === 409) {
    if (name === "invalid_idempotent_request") {
      return yield* new EmailRejected({
        provider: "resend",
        reason: "idempotency-conflict",
        status,
      });
    }

    return yield* new EmailDeliveryUnknown({
      provider: "resend",
      reason: "unexpected-status",
      status,
    });
  }

  if (status < 400 || status >= 500) {
    return yield* new EmailDeliveryUnknown({
      provider: "resend",
      reason: "unexpected-status",
      status,
    });
  }

  const reason = Match.value(status).pipe(
    Match.when(401, () => "authentication" as const),
    Match.when(403, () =>
      name === "validation_error" ? ("invalid-message" as const) : ("authentication" as const),
    ),
    Match.when(429, () =>
      name === "rate_limit_exceeded" ? ("rate-limited" as const) : ("rejected" as const),
    ),
    Match.when(
      (value) => value === 400 || value === 422,
      () => "invalid-message" as const,
    ),
    Match.orElse(() => "rejected" as const),
  );

  const delay = parseEmailHttpRetryAfterMillis(response.headers["retry-after"]);
  const rejection = new EmailRejected({ provider: "resend", reason, status });

  return yield* delay.pipe(
    Match.value,
    Match.tag("Some", ({ value }) =>
      Effect.fail(
        new EmailRejected({
          provider: "resend",
          reason,
          retryAfterMillis: value,
          status,
        }),
      ),
    ),
    Match.tag("None", () => Effect.fail(rejection)),
    Match.exhaustive,
  );
});

const validateResendMessage = Effect.fnUntraced(function* validateResendMessage(
  message: EmailSubmission["message"],
): Effect.fn.Return<void, EmailInvalidMessage> {
  if (
    message.sendAt !== undefined &&
    !supportsResendScheduledInstant(message.sendAt, DateTime.toEpochMillis(yield* DateTime.now))
  ) {
    return yield* new EmailInvalidMessage({
      issues: [
        {
          path: "sendAt",
          problem:
            "Resend scheduling requires a future UTC instant within 30 days and a four-digit year",
        },
      ],
    });
  }

  return undefined;
});

const resendPreflight = {
  capabilities: resendEmailCapabilities,
  idempotency: EmailSenderIdempotencySchema.cases.Native.make({ retention: Duration.hours(24) }),
  provider: "resend",
  validate: validateResendMessage,
};

const resendProvider = defineEmailHttpProvider({
  configuration: ResendConfiguration,
  makeProtocol: ({ apiKey }) => {
    const request = Effect.fnUntraced(function* buildResendRequest(
      submission: EmailSubmission,
    ): Effect.fn.Return<HttpClientRequest.HttpClientRequest, EmailRejected> {
      const { message } = submission;

      const unkeyedRequest = yield* HttpClientRequest.post("https://api.resend.com/emails").pipe(
        HttpClientRequest.bearerToken(Redacted.value(apiKey)),
        HttpClientRequest.acceptJson,
        HttpClientRequest.bodyJson({
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
          scheduled_at:
            message.sendAt === undefined ? undefined : DateTime.formatIso(message.sendAt),
          subject: message.subject,
          tags: message.tags,
          text: message.body.text,
          to: message.to.map(formatEmailMailbox),
        }),
        Effect.mapError(() => new EmailRejected({ provider: "resend", reason: "invalid-message" })),
      );

      return submission.idempotencyKey === undefined
        ? unkeyedRequest
        : HttpClientRequest.setHeader(unkeyedRequest, "Idempotency-Key", submission.idempotencyKey);
    });

    const respond = Effect.fnUntraced(function* readResendAcknowledgement(
      response: HttpClientResponse.HttpClientResponse,
    ): Effect.fn.Return<EmailReceipt, EmailSubmissionError> {
      if (response.status < 200 || response.status >= 300) {
        return yield* classifyRejection(response);
      }

      const acknowledgement = yield* readEmailHttpJson(response, "resend").pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(ResendAcknowledgement)),
        Effect.mapError(
          () =>
            new EmailDeliveryUnknown({
              provider: "resend",
              reason: "invalid-response",
              status: response.status,
            }),
        ),
      );

      return EmailReceiptSchema.cases.Accepted.make({
        messageId: acknowledgement.id,
        provider: "resend",
      });
    });

    return Effect.succeed({ request, respond });
  },
  profile: resendPreflight,
  span: "Resend.submit",
});

export const preflightResendEmail = resendProvider.preflight;

export const resendSenderLayer = resendProvider.senderLayer;

export const resendEmailLayer = resendProvider.emailLayer;
