import { Duration, Effect, Layer, Match, Option, Redacted, Schema } from "effect";
import type { HttpClient, HttpClientResponse } from "effect/http";
import { HttpClientRequest } from "effect/http";
import { EmailAddressSchema } from "./email-address.js";
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
import { parseEmailHttpRetryAfterMillis } from "./email-http-retry-after.js";
import { EmailInvalidMessage } from "./email-invalid-message.js";
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

export const plunkEmailCapabilities = ownEmailSenderCapabilities(
  EmailSenderCapabilitiesSchema.make({
    attachmentContentTypes: "Explicit",
    attachments: true,
    headers: "Unique",
    inlineAttachments: true,
    metadata: false,
    scheduling: false,
    tags: { asciiOnly: false, maxCount: 0 },
  }),
);

export interface PlunkEmailOptions {
  readonly apiKey: Redacted.Redacted;
  readonly contactWrites: "AllowUpsert";
  readonly tracking: "ProjectDisabled";
}

const PlunkConfiguration = Schema.Struct({
  apiKey: Schema.Redacted(
    EmailHttpCredentialTextSchema.check(
      Schema.isPattern(/^sk_.+$/u, {
        expected: "a Plunk secret submission key, not a public tracking key",
      }),
    ),
  ),
  contactWrites: Schema.Literal("AllowUpsert"),
  tracking: Schema.Literal("ProjectDisabled"),
});

const PlunkAcknowledgement = Schema.Struct({
  data: Schema.Struct({
    emails: Schema.NonEmptyArray(
      Schema.Struct({
        contact: Schema.Struct({ email: EmailAddressSchema }),
        email: EmailMessageIdSchema,
      }),
    ).check(Schema.isMaxLength(1)),
  }),
  error: Schema.optionalKey(Schema.Null),
  success: Schema.Literal(true),
});

const PlunkRejectionCode = Schema.Struct({
  error: Schema.Struct({ code: Schema.String.check(Schema.isMaxLength(128)) }),
  success: Schema.Literal(false),
});

const plunkMailboxAddress = (mailbox: EmailMailbox) =>
  Schema.is(EmailAddressSchema)(mailbox) ? mailbox : mailbox.address;

const formatPlunkMailbox = (mailbox: EmailMailbox) =>
  Schema.is(EmailAddressSchema)(mailbox)
    ? { email: mailbox }
    : { email: mailbox.address, name: mailbox.name };

const classifyPlunkRejection = Effect.fnUntraced(function* classifyPlunkRejection(
  response: HttpClientResponse.HttpClientResponse,
): Effect.fn.Return<never, EmailSubmissionError> {
  const { status } = response;

  if (status >= 500) {
    return yield* new EmailDeliveryUnknown({ provider: "plunk", reason: "server-error", status });
  }

  if (status === 409 || status === 429) {
    const code = yield* readEmailHttpJson(response, "plunk").pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(PlunkRejectionCode)),
      Effect.map((body) => body.error.code),
      Effect.orElseSucceed(() => "unclassified"),
    );

    if (status === 409) {
      if (code === "IDEMPOTENCY_KEY_REUSED") {
        return yield* new EmailRejected({
          provider: "plunk",
          reason: "idempotency-conflict",
          status,
        });
      }

      return yield* new EmailDeliveryUnknown({
        provider: "plunk",
        reason: "unexpected-status",
        status,
      });
    }

    if (code !== "RATE_LIMIT_EXCEEDED") {
      return yield* new EmailRejected({ provider: "plunk", reason: "rejected", status });
    }

    return yield* Option.match(parseEmailHttpRetryAfterMillis(response.headers["retry-after"]), {
      onNone: () => new EmailRejected({ provider: "plunk", reason: "rate-limited", status }),
      onSome: (retryAfterMillis) =>
        new EmailRejected({ provider: "plunk", reason: "rate-limited", retryAfterMillis, status }),
    });
  }

  const reason = Match.value(status).pipe(
    Match.when(
      (code) => code === 400 || code === 413 || code === 422,
      () => "invalid-message" as const,
    ),
    Match.when(401, () => "authentication" as const),
    Match.when(
      (code) => code === 402 || code === 403 || code === 404 || code === 405,
      () => "rejected" as const,
    ),
    Match.orElse(() => "unexpected-status" as const),
  );

  if (reason === "unexpected-status") {
    return yield* new EmailDeliveryUnknown({ provider: "plunk", reason, status });
  }

  return yield* new EmailRejected({ provider: "plunk", reason, status });
});

export const plunkSenderLayer = (
  options: PlunkEmailOptions,
): Layer.Layer<EmailSender, EmailConfigurationError, HttpClient.HttpClient> =>
  emailHttpSenderLayer(PlunkConfiguration, options, (configuration) => {
    const validate = Effect.fnUntraced(function* validatePlunkIntent(
      message: EmailSubmission["message"],
    ): Effect.fn.Return<void, EmailInvalidMessage> {
      yield* validateEmailCapabilities(message, plunkEmailCapabilities);

      if (message.to.length !== 1 || message.cc !== undefined || message.bcc !== undefined) {
        return yield* new EmailInvalidMessage({
          issues: [
            {
              path: "to",
              problem:
                "Plunk single submission requires one recipient without cc or bcc; use explicit settled sends for separate recipients",
            },
          ],
        });
      }

      if (message.body.html === undefined || message.body.text !== undefined) {
        return yield* new EmailInvalidMessage({
          issues: [
            {
              path: "body",
              problem: "Plunk requires HTML and generates its own plain-text alternative",
            },
          ],
        });
      }

      if (
        message.replyTo !== undefined &&
        (message.replyTo.length !== 1 || !Schema.is(EmailAddressSchema)(message.replyTo[0]))
      ) {
        return yield* new EmailInvalidMessage({
          issues: [{ path: "replyTo", problem: "Plunk supports one plain reply-to mailbox" }],
        });
      }

      return undefined;
    });

    const request = Effect.fnUntraced(function* buildPlunkRequest(
      submission: EmailSubmission,
    ): Effect.fn.Return<HttpClientRequest.HttpClientRequest, EmailRejected> {
      const { message } = submission;
      const [replyTo] = message.replyTo ?? [];

      const unkeyed = yield* HttpClientRequest.post("https://next-api.useplunk.com/v1/send").pipe(
        HttpClientRequest.bearerToken(Redacted.value(configuration.apiKey)),
        HttpClientRequest.acceptJson,
        HttpClientRequest.bodyJson({
          attachments: message.attachments?.map((attachment) => ({
            content: attachment.contentBase64,
            contentId: attachment.contentId,
            contentType: attachment.contentType,
            disposition: attachment.contentId === undefined ? "attachment" : "inline",
            filename: attachment.filename,
          })),
          body: message.body.html,
          from: formatPlunkMailbox(message.from),
          headers:
            message.headers === undefined
              ? undefined
              : Object.fromEntries(message.headers.map(({ name, value }) => [name, value])),
          reply: replyTo === undefined ? undefined : plunkMailboxAddress(replyTo),
          subject: message.subject,
          to: formatPlunkMailbox(message.to[0]),
        }),
        Effect.mapError(() => new EmailRejected({ provider: "plunk", reason: "invalid-message" })),
      );

      return submission.idempotencyKey === undefined
        ? unkeyed
        : HttpClientRequest.setHeader(unkeyed, "Idempotency-Key", submission.idempotencyKey);
    });

    const respond = Effect.fnUntraced(function* readPlunkAcknowledgement(
      response: HttpClientResponse.HttpClientResponse,
      message: EmailSubmission["message"],
    ): Effect.fn.Return<EmailReceipt, EmailSubmissionError> {
      if (response.status !== 200) {
        return yield* classifyPlunkRejection(response);
      }

      const acknowledgement = yield* readEmailHttpJson(response, "plunk").pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(PlunkAcknowledgement)),
        Effect.mapError(
          () =>
            new EmailDeliveryUnknown({
              provider: "plunk",
              reason: "invalid-response",
              status: response.status,
            }),
        ),
      );

      const [accepted] = acknowledgement.data.emails;

      if (
        accepted.contact.email.toLowerCase() !== plunkMailboxAddress(message.to[0]).toLowerCase()
      ) {
        return yield* new EmailDeliveryUnknown({
          provider: "plunk",
          reason: "invalid-response",
          status: response.status,
        });
      }

      return Object.freeze(
        EmailReceiptSchema.cases.Accepted.make({ messageId: accepted.email, provider: "plunk" }),
      );
    });

    return {
      capabilities: plunkEmailCapabilities,
      idempotency: EmailSenderIdempotencySchema.cases.Native.make({
        maxKeyLength: 255,
        retention: Duration.hours(24),
      }),
      provider: "plunk",
      request,
      respond,
      span: "Plunk.submit",
      validate,
    };
  });

export const plunkEmailLayer = (
  options: PlunkEmailOptions,
  policy?: EmailDeliveryPolicy,
  observer?: EmailRetryObserver,
  restriction?: EmailRetryRestriction,
): Layer.Layer<Email, EmailConfigurationError, HttpClient.HttpClient> =>
  emailLayer(policy, observer, restriction).pipe(Layer.provide(plunkSenderLayer(options)));
