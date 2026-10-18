import { DateTime, Effect, Layer, Match, Option, Redacted, Schema } from "effect";
import type { HttpClient, HttpClientResponse } from "effect/http";
import { HttpClientRequest } from "effect/http";
import { formatEmailMailbox } from "./email-address.js";
import { emailAttachmentMimeType } from "./email-attachment.js";
import {
  EmailSenderCapabilitiesSchema,
  ownEmailSenderCapabilities,
  validateEmailCapabilities,
} from "./email-capabilities.js";
import type { EmailConfigurationError } from "./email-configuration-error.js";
import { EmailDeliveryUnknown } from "./email-delivery-unknown.js";
import type { EmailSubmissionError } from "./email-errors.js";
import { emailHttpSenderLayer } from "./email-http-protocol.js";
import { EmailHttpCredentialSchema } from "./email-http-credential.js";
import { readEmailHttpJson } from "./email-http-response.js";
import { parseEmailHttpRetryAfterMillis } from "./email-http-retry-after.js";
import { EmailInvalidMessage } from "./email-invalid-message.js";
import { EmailMessageIdSchema, EmailReceiptSchema } from "./email-message.js";
import type { EmailMessageInput, EmailReceipt } from "./email-message.js";
import type { EmailSendOptionsInput } from "./email-preparation.js";
import { preflightEmailMessage } from "./email-preflight.js";
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

export const unosendEmailCapabilities = ownEmailSenderCapabilities(
  EmailSenderCapabilitiesSchema.make({
    attachmentContentTypes: "Explicit",
    attachments: true,
    headers: "Unique",
    inlineAttachments: false,
    metadata: false,
    scheduling: true,
    tags: { asciiOnly: false, maxCount: 75 },
  }),
);

export interface UnosendEmailOptions {
  readonly apiKey: Redacted.Redacted;
}

const UnosendConfiguration = Schema.Struct({
  apiKey: EmailHttpCredentialSchema,
});

const UnosendAcknowledgement = Schema.Struct({
  data: Schema.Struct({ id: EmailMessageIdSchema }),
  error: Schema.optionalKey(Schema.Null),
  success: Schema.Literal(true),
});

const UnosendErrorCode = Schema.Struct({
  error: Schema.Struct({ code: Schema.String.check(Schema.isMaxLength(128)) }),
});

const UnosendAttachmentMimeType = Schema.Literals([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "text/csv",
  "text/plain",
  "application/zip",
  "application/json",
  "text/html",
]);

const classifyUnosendRejection = Effect.fnUntraced(function* classifyUnosendRejection(
  response: HttpClientResponse.HttpClientResponse,
): Effect.fn.Return<never, EmailSubmissionError> {
  const { status } = response;

  if (status >= 500) {
    return yield* new EmailDeliveryUnknown({ provider: "unosend", reason: "server-error", status });
  }

  const reason = Match.value(status).pipe(
    Match.when(
      (code) => code === 400 || code === 413 || code === 422,
      () => "invalid-message" as const,
    ),
    Match.when(
      (code) => code === 401 || code === 403,
      () => "authentication" as const,
    ),
    Match.when(404, () => "rejected" as const),
    Match.when(429, () => "rejected" as const),
    Match.orElse(() => "unexpected-status" as const),
  );

  if (reason === "unexpected-status") {
    return yield* new EmailDeliveryUnknown({ provider: "unosend", reason, status });
  }

  if (status !== 429) {
    return yield* new EmailRejected({ provider: "unosend", reason, status });
  }

  const errorCode = yield* readEmailHttpJson(response, "unosend").pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(UnosendErrorCode)),
    Effect.map((body) => body.error.code),
    Effect.orElseSucceed(() => "unclassified"),
  );

  if (errorCode !== "rate_limit_exceeded") {
    return yield* new EmailRejected({ provider: "unosend", reason: "rejected", status });
  }

  return yield* Option.match(parseEmailHttpRetryAfterMillis(response.headers["retry-after"]), {
    onNone: () => new EmailRejected({ provider: "unosend", reason: "rate-limited", status }),
    onSome: (retryAfterMillis) =>
      new EmailRejected({ provider: "unosend", reason: "rate-limited", retryAfterMillis, status }),
  });
});

const validateUnosendIntent = Effect.fnUntraced(function* validateUnosendIntent(
  message: EmailSubmission["message"],
): Effect.fn.Return<void, EmailInvalidMessage> {
  yield* validateEmailCapabilities(message, unosendEmailCapabilities);

  if (message.replyTo !== undefined && message.replyTo.length !== 1) {
    return yield* new EmailInvalidMessage({
      issues: [{ path: "replyTo", problem: "Unosend supports one reply-to address" }],
    });
  }

  if (
    message.attachments?.some(
      (attachment) => !Schema.is(UnosendAttachmentMimeType)(attachment.contentType),
    ) === true
  ) {
    return yield* new EmailInvalidMessage({
      issues: [
        { path: "attachments", problem: "Unosend requires a documented supported MIME type" },
      ],
    });
  }

  return undefined;
});

const unosendPreflight = {
  capabilities: unosendEmailCapabilities,
  idempotency: EmailSenderIdempotencySchema.cases.None.make({}),
  provider: "unosend",
  validate: validateUnosendIntent,
};

export const preflightUnosendEmail = (
  message: EmailMessageInput,
  options?: EmailSendOptionsInput,
) => preflightEmailMessage(unosendPreflight, message, options);

export const unosendSenderLayer = (
  options: UnosendEmailOptions,
): Layer.Layer<EmailSender, EmailConfigurationError, HttpClient.HttpClient> =>
  emailHttpSenderLayer(UnosendConfiguration, options, (configuration) => {
    const request = Effect.fnUntraced(function* buildUnosendRequest(
      submission: EmailSubmission,
    ): Effect.fn.Return<HttpClientRequest.HttpClientRequest, EmailRejected> {
      const { message } = submission;
      const [replyTo] = message.replyTo ?? [];

      return yield* HttpClientRequest.post("https://api.unosend.co/emails").pipe(
        HttpClientRequest.bearerToken(Redacted.value(configuration.apiKey)),
        HttpClientRequest.acceptJson,
        HttpClientRequest.bodyJson({
          attachments: message.attachments?.map((attachment) => ({
            content: attachment.contentBase64,
            content_type: emailAttachmentMimeType(attachment),
            filename: attachment.filename,
          })),
          bcc: message.bcc?.map(formatEmailMailbox),
          cc: message.cc?.map(formatEmailMailbox),
          from: formatEmailMailbox(message.from),
          headers:
            message.headers === undefined
              ? undefined
              : Object.fromEntries(message.headers.map(({ name, value }) => [name, value])),
          html: message.body.html,
          reply_to: replyTo === undefined ? undefined : formatEmailMailbox(replyTo),
          scheduled_for:
            message.sendAt === undefined ? undefined : DateTime.formatIso(message.sendAt),
          subject: message.subject,
          tags: message.tags,
          text: message.body.text,
          to: message.to.map(formatEmailMailbox),
          tracking: { click: false, open: false },
        }),
        Effect.mapError(
          () => new EmailRejected({ provider: "unosend", reason: "invalid-message" }),
        ),
      );
    });

    const respond = Effect.fnUntraced(function* readUnosendAcknowledgement(
      response: HttpClientResponse.HttpClientResponse,
    ): Effect.fn.Return<EmailReceipt, EmailSubmissionError> {
      if (response.status !== 200) {
        return yield* classifyUnosendRejection(response);
      }

      const acknowledgement = yield* readEmailHttpJson(response, "unosend").pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(UnosendAcknowledgement)),
        Effect.mapError(
          () =>
            new EmailDeliveryUnknown({
              provider: "unosend",
              reason: "invalid-response",
              status: response.status,
            }),
        ),
      );

      return EmailReceiptSchema.cases.Accepted.make({
        messageId: acknowledgement.data.id,
        provider: "unosend",
      });
    });

    return {
      ...unosendPreflight,
      request,
      respond,
      span: "Unosend.submit",
    };
  });

export const unosendEmailLayer = (
  options: UnosendEmailOptions,
  policy?: EmailDeliveryPolicy,
  observer?: EmailRetryObserver,
  restriction?: EmailRetryRestriction,
): Layer.Layer<Email, EmailConfigurationError, HttpClient.HttpClient> =>
  emailLayer(policy, observer, restriction).pipe(Layer.provide(unosendSenderLayer(options)));
