import { DateTime, Duration, Effect, Layer, Match, Option, Redacted, Schema } from "effect";
import type { HttpClient, HttpClientResponse } from "effect/http";
import { HttpClientRequest } from "effect/http";
import { EmailAddressSchema, formatEmailMailbox } from "./email-address.js";
import { emailAttachmentMimeType } from "./email-attachment.js";
import {
  EmailSenderCapabilitiesSchema,
  ownEmailSenderCapabilities,
  validateEmailCapabilities,
} from "./email-capabilities.js";
import type { EmailConfigurationError } from "./email-configuration-error.js";
import { EmailDeliveryUnknown } from "./email-delivery-unknown.js";
import type { EmailSubmissionError } from "./email-errors.js";
import { EmailHttpCredentialSchema } from "./email-http-credential.js";
import { emailHttpSenderLayer } from "./email-http-protocol.js";
import { readEmailHttpJson } from "./email-http-response.js";
import { parseEmailHttpRetryAfterMillis } from "./email-http-retry-after.js";
import { EmailInvalidMessage } from "./email-invalid-message.js";
import { EmailSendAtSchema } from "./email-message-metadata.js";
import { EmailMessageIdSchema, EmailReceiptSchema } from "./email-message.js";
import type { EmailReceipt } from "./email-message.js";
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

export const lettermintEmailCapabilities = ownEmailSenderCapabilities(
  EmailSenderCapabilitiesSchema.make({
    attachmentContentTypes: "Both",
    attachments: true,
    headers: "Unique",
    inlineAttachments: true,
    metadata: true,
    scheduling: true,
    tags: Object.freeze({ asciiOnly: true, maxCount: 20 }),
  }),
);

export interface LettermintEmailOptions {
  readonly apiToken: Redacted.Redacted;
  readonly route?: string;
}

const LettermintConfiguration = Schema.Struct({
  apiToken: EmailHttpCredentialSchema,
  route: Schema.optionalKey(
    Schema.String.check(
      Schema.isMaxLength(64),
      Schema.isPattern(/^[a-z][a-z0-9_-]*$/u, { expected: "an opaque Lettermint route slug" }),
    ),
  ),
});

const LettermintAcknowledgement = Schema.Struct({
  message_id: EmailMessageIdSchema,
  sandbox: Schema.optionalKey(Schema.Literal(true)),
  sandbox_result: Schema.optionalKey(
    Schema.Literals([
      "delivered",
      "hard_bounced",
      "soft_bounced",
      "deferred",
      "failed",
      "suppressed",
      "spam_complaint",
      "auto_replied",
      "opened",
      "clicked",
      "unsubscribed",
    ]),
  ),
  scheduled_at: Schema.optionalKey(Schema.String),
  status: Schema.Literals(["pending", "scheduled"]),
});

const LettermintErrorCode = Schema.Struct({
  error: Schema.Struct({ code: Schema.String.check(Schema.isMaxLength(128)) }),
});

const LettermintPayloadConflict = Schema.Struct({
  message: Schema.Literal(
    "This idempotency key has already been used on a request with a different payload. Retrying this request requires changing the idempotency key or payload.",
  ),
});

const lettermintHeaders = (message: EmailSubmission["message"]) => {
  if (message.headers === undefined) {
    return message.headers;
  }

  const headers = Object.fromEntries(message.headers.map((header) => [header.name, header.value]));

  if (
    message.headers.some((header) => header.name.toLowerCase() === "message-id") &&
    !message.headers.some((header) => header.name.toLowerCase() === "x-lm-preserve-message-id")
  ) {
    return { ...headers, "X-LM-Preserve-Message-ID": "true" };
  }

  return headers;
};

const isConsistentLettermintAcknowledgement = (
  acknowledgement: typeof LettermintAcknowledgement.Type,
  message: EmailSubmission["message"],
): boolean => {
  if (acknowledgement.sandbox_result !== undefined && acknowledgement.sandbox !== true) {
    return false;
  }

  if (acknowledgement.status === "pending") {
    return message.sendAt === undefined && acknowledgement.scheduled_at === undefined;
  }

  if (message.sendAt === undefined || acknowledgement.scheduled_at === undefined) {
    return false;
  }

  const timestamp = Schema.decodeOption(EmailSendAtSchema)(
    acknowledgement.scheduled_at.replace(/\+00:00$/u, "Z"),
  );

  return (
    Option.isSome(timestamp) &&
    DateTime.toEpochMillis(timestamp.value) === DateTime.toEpochMillis(message.sendAt)
  );
};

export const lettermintSenderLayer = (
  options: LettermintEmailOptions,
): Layer.Layer<EmailSender, EmailConfigurationError, HttpClient.HttpClient> =>
  emailHttpSenderLayer(LettermintConfiguration, options, (configuration) => {
    const validate = Effect.fnUntraced(function* validateLettermintMessage(
      message: EmailSubmission["message"],
    ): Effect.fn.Return<void, EmailInvalidMessage> {
      yield* validateEmailCapabilities(message, lettermintEmailCapabilities);
      const issues: string[] = [];

      if (
        (message.body.text !== undefined && message.body.text.length < 3) ||
        (message.body.html !== undefined && message.body.html.length < 3)
      ) {
        issues.push("body");
      }

      if (
        message.tags?.some(
          (tag) =>
            !/^[A-Za-z0-9_-]{1,32}$/u.test(tag.name) || !/^[A-Za-z0-9_-]{1,64}$/u.test(tag.value),
        ) === true
      ) {
        issues.push("tags");
      }

      if (
        message.attachments?.some(
          (attachment) => attachment.contentId !== undefined && !attachment.contentId.includes("@"),
        ) === true
      ) {
        issues.push("attachments");
      }

      if (
        message.headers?.some(
          (header) =>
            header.name.toLowerCase() === "x-lettermint-token" ||
            (header.name.toLowerCase() === "message-id" &&
              (!header.value.startsWith("<") ||
                !header.value.endsWith(">") ||
                !Schema.is(EmailAddressSchema)(header.value.slice(1, -1)))) ||
            (header.name.toLowerCase() === "x-lm-preserve-message-id" &&
              !["true", "1"].includes(header.value.toLowerCase())),
        ) === true
      ) {
        issues.push("headers");
      }

      if (issues.length > 0) {
        return yield* new EmailInvalidMessage({
          issues: issues.map((path) => ({
            path,
            problem: "Intent is not representable by Lettermint",
          })),
        });
      }

      return undefined;
    });

    const request = Effect.fnUntraced(function* buildLettermintRequest(
      submission: EmailSubmission,
    ): Effect.fn.Return<HttpClientRequest.HttpClientRequest, EmailRejected> {
      const { message } = submission;

      const unkeyed = yield* HttpClientRequest.post("https://api.lettermint.co/v1/send").pipe(
        HttpClientRequest.setHeader("x-lettermint-token", Redacted.value(configuration.apiToken)),
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
          headers: lettermintHeaders(message),
          html: message.body.html,
          metadata: message.metadata,
          reply_to: message.replyTo?.map(formatEmailMailbox),
          route: configuration.route,
          scheduled_at:
            message.sendAt === undefined ? undefined : DateTime.formatIso(message.sendAt),
          settings: { track_clicks: false, track_opens: false },
          subject: message.subject,
          tags: message.tags,
          text: message.body.text,
          to: message.to.map(formatEmailMailbox),
        }),
        Effect.mapError(
          () => new EmailRejected({ provider: "lettermint", reason: "invalid-message" }),
        ),
      );

      return submission.idempotencyKey === undefined
        ? unkeyed
        : HttpClientRequest.setHeader(unkeyed, "Idempotency-Key", submission.idempotencyKey);
    });

    const respond = Effect.fnUntraced(function* readLettermintResponse(
      response: HttpClientResponse.HttpClientResponse,
      message: EmailSubmission["message"],
    ): Effect.fn.Return<EmailReceipt, EmailSubmissionError> {
      const { status } = response;

      if (status >= 500) {
        return yield* new EmailDeliveryUnknown({
          provider: "lettermint",
          reason: "server-error",
          status,
        });
      }

      if (status === 202) {
        const acknowledgement = yield* readEmailHttpJson(response, "lettermint").pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(LettermintAcknowledgement)),
          Effect.mapError(
            () =>
              new EmailDeliveryUnknown({
                provider: "lettermint",
                reason: "invalid-response",
                status,
              }),
          ),
        );

        if (!isConsistentLettermintAcknowledgement(acknowledgement, message)) {
          return yield* new EmailDeliveryUnknown({
            provider: "lettermint",
            reason: "invalid-response",
            status,
          });
        }

        const fields = { messageId: acknowledgement.message_id, provider: "lettermint" };

        return Object.freeze(
          acknowledgement.sandbox === true
            ? EmailReceiptSchema.cases.Simulated.make(fields)
            : EmailReceiptSchema.cases.Accepted.make(fields),
        );
      }

      if (status === 403 || status === 409 || status === 429) {
        const body = yield* readEmailHttpJson(response, "lettermint").pipe(Effect.option);

        const code = body.pipe(
          Option.flatMap(Schema.decodeUnknownOption(LettermintErrorCode)),
          Option.map((error) => error.error.code),
        );

        if (status === 403) {
          return yield* new EmailRejected({
            provider: "lettermint",
            reason: Option.contains(code, "FEATURE_NOT_AVAILABLE") ? "rejected" : "authentication",
            status,
          });
        }

        if (status === 409) {
          if (
            Option.contains(code, "invalid_idempotent_request") ||
            Option.exists(body, Schema.is(LettermintPayloadConflict))
          ) {
            return yield* new EmailRejected({
              provider: "lettermint",
              reason: "idempotency-conflict",
              status,
            });
          }

          return yield* new EmailDeliveryUnknown({
            provider: "lettermint",
            reason: "unexpected-status",
            status,
          });
        }

        const delay = parseEmailHttpRetryAfterMillis(response.headers["retry-after"]);

        const fields = {
          provider: "lettermint",
          reason: Option.contains(code, "RATE_LIMITED")
            ? ("rate-limited" as const)
            : ("rejected" as const),
          status,
        };

        if (Option.isSome(delay)) {
          return yield* new EmailRejected({ ...fields, retryAfterMillis: delay.value });
        }

        return yield* new EmailRejected(fields);
      }

      const reason = Match.value(status).pipe(
        Match.when(
          (value) => value === 400 || value === 413 || value === 422,
          () => "invalid-message" as const,
        ),
        Match.when(
          (value) => value === 401 || value === 403,
          () => "authentication" as const,
        ),
        Match.when(
          (value) => value === 404 || value === 405,
          () => "rejected" as const,
        ),
        Match.orElse(() => "unexpected-status" as const),
      );

      return yield* reason === "unexpected-status"
        ? new EmailDeliveryUnknown({ provider: "lettermint", reason: "unexpected-status", status })
        : new EmailRejected({ provider: "lettermint", reason, status });
    });

    return {
      capabilities: lettermintEmailCapabilities,
      idempotency: EmailSenderIdempotencySchema.cases.Native.make({
        maxKeyLength: 255,
        retention: Duration.hours(24),
      }),
      provider: "lettermint",
      request,
      respond,
      span: "Lettermint.submit",
      validate,
    };
  });

export const lettermintEmailLayer = (
  options: LettermintEmailOptions,
  policy?: EmailDeliveryPolicy,
  observer?: EmailRetryObserver,
  restriction?: EmailRetryRestriction,
): Layer.Layer<Email, EmailConfigurationError, HttpClient.HttpClient> =>
  emailLayer(policy, observer, restriction).pipe(Layer.provide(lettermintSenderLayer(options)));
