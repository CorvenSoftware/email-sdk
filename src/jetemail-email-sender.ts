import { DateTime, Effect, Layer, Option, Redacted, Schema } from "effect";
import { HttpClientRequest } from "effect/http";
import type { HttpClient, HttpClientResponse } from "effect/http";
import { EmailAddressSchema, formatEmailMailbox } from "./email-address.js";
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

export const jetemailEmailCapabilities = ownEmailSenderCapabilities(
  EmailSenderCapabilitiesSchema.make({
    attachmentContentTypes: "ProviderSelected",
    attachments: true,
    headers: "Unique",
    inlineAttachments: false,
    metadata: false,
    scheduling: true,
    tags: { asciiOnly: false, maxCount: 0 },
  }),
);

export interface JetemailEmailOptions {
  readonly apiKey: Redacted.Redacted;
  readonly automaticBcc: "DomainDisabled";
  readonly deliveryRegion?: "ProviderSelected" | "Europe";
  readonly tracking: "DomainDisabled";
}

const JetemailConfiguration = Schema.Struct({
  apiKey: Schema.Redacted(
    EmailHttpCredentialTextSchema.check(
      Schema.isPattern(/^transactional_.+$/u, {
        expected: "a JetEmail transactional submission token",
      }),
    ),
  ),
  automaticBcc: Schema.Literal("DomainDisabled"),
  deliveryRegion: Schema.optionalKey(Schema.Literals(["ProviderSelected", "Europe"])),
  tracking: Schema.Literal("DomainDisabled"),
});

const JetemailImmediateAcknowledgement = Schema.Struct({
  error: Schema.optionalKey(Schema.Null),
  id: EmailMessageIdSchema,
  scheduled_at: Schema.optionalKey(Schema.Null),
});

const JetemailScheduledAcknowledgement = Schema.Struct({
  error: Schema.optionalKey(Schema.Null),
  id: EmailMessageIdSchema.check(Schema.isUUID()),
  scheduled_at: Schema.Int,
});

const classifyJetemailRejection = (
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<never, EmailSubmissionError> => {
  const { status } = response;

  if (status >= 500) {
    return Effect.fail(
      new EmailDeliveryUnknown({ provider: "jetemail", reason: "server-error", status }),
    );
  }

  if (status === 401) {
    return Effect.fail(
      new EmailRejected({ provider: "jetemail", reason: "authentication", status }),
    );
  }

  if (status === 429) {
    return Option.match(parseEmailHttpRetryAfterMillis(response.headers["retry-after"]), {
      onNone: () =>
        Effect.fail(new EmailRejected({ provider: "jetemail", reason: "rate-limited", status })),
      onSome: (retryAfterMillis) =>
        Effect.fail(
          new EmailRejected({
            provider: "jetemail",
            reason: "rate-limited",
            retryAfterMillis,
            status,
          }),
        ),
    });
  }

  return Effect.fail(
    new EmailDeliveryUnknown({ provider: "jetemail", reason: "unexpected-status", status }),
  );
};

export const jetemailSenderLayer = (
  options: JetemailEmailOptions,
): Layer.Layer<EmailSender, EmailConfigurationError, HttpClient.HttpClient> =>
  emailHttpSenderLayer(JetemailConfiguration, options, (configuration) => {
    const validate = Effect.fnUntraced(function* validateJetemailIntent(
      message: EmailSubmission["message"],
    ): Effect.fn.Return<void, EmailInvalidMessage> {
      yield* validateEmailCapabilities(message, jetemailEmailCapabilities);
      const issues = [];

      if (Schema.is(EmailAddressSchema)(message.from) || message.from.name === undefined) {
        issues.push({ path: "from", problem: "JetEmail requires an explicit sender display name" });
      }

      if (
        message.to.some(
          (mailbox) => !Schema.is(EmailAddressSchema)(mailbox) && mailbox.name !== undefined,
        )
      ) {
        issues.push({
          path: "to",
          problem: "JetEmail's documented to field requires plain mailboxes",
        });
      }

      if (message.sendAt !== undefined && DateTime.toEpochMillis(message.sendAt) % 1000 !== 0) {
        issues.push({
          path: "sendAt",
          problem: "JetEmail scheduling requires whole seconds without truncation",
        });
      }

      if (
        message.headers?.some(
          ({ name }) =>
            ["x-idempotency-key", "x-scheduled-at"].includes(name.toLowerCase()) ||
            name.toLowerCase().startsWith("x-jetemail-"),
        ) === true
      ) {
        issues.push({
          path: "headers",
          problem: "JetEmail submission controls cannot be overridden through message headers",
        });
      }

      if (issues.length > 0) {
        return yield* new EmailInvalidMessage({ issues });
      }

      return undefined;
    });

    const request = Effect.fnUntraced(function* buildJetemailRequest(
      submission: EmailSubmission,
    ): Effect.fn.Return<HttpClientRequest.HttpClientRequest, EmailRejected> {
      const { message } = submission;

      const unkeyed = yield* HttpClientRequest.post("https://api.jetemail.com/email").pipe(
        HttpClientRequest.bearerToken(Redacted.value(configuration.apiKey)),
        HttpClientRequest.acceptJson,
        HttpClientRequest.bodyJson({
          attachments: message.attachments?.map((attachment) => ({
            data: attachment.contentBase64,
            filename: attachment.filename,
          })),
          bcc: message.bcc?.map(formatEmailMailbox),
          cc: message.cc?.map(formatEmailMailbox),
          eu: configuration.deliveryRegion === "Europe",
          from: formatEmailMailbox(message.from),
          headers:
            message.headers === undefined
              ? undefined
              : Object.fromEntries(message.headers.map(({ name, value }) => [name, value])),
          html: message.body.html,
          reply_to: message.replyTo?.map(formatEmailMailbox),
          scheduledAt:
            message.sendAt === undefined ? undefined : DateTime.formatIso(message.sendAt),
          subject: message.subject,
          text: message.body.text,
          to: message.to.map(formatEmailMailbox),
        }),
        Effect.mapError(
          () => new EmailRejected({ provider: "jetemail", reason: "invalid-message" }),
        ),
      );

      return submission.idempotencyKey === undefined
        ? unkeyed
        : HttpClientRequest.setHeader(unkeyed, "Idempotency-Key", submission.idempotencyKey);
    });

    const respond = Effect.fnUntraced(function* readJetemailAcknowledgement(
      response: HttpClientResponse.HttpClientResponse,
      message: EmailSubmission["message"],
    ): Effect.fn.Return<EmailReceipt, EmailSubmissionError> {
      const expectedStatus = message.sendAt === undefined ? 201 : 202;

      if (response.status !== expectedStatus) {
        return yield* classifyJetemailRejection(response);
      }

      const invalid = () =>
        new EmailDeliveryUnknown({
          provider: "jetemail",
          reason: "invalid-response",
          status: response.status,
        });

      const body = yield* readEmailHttpJson(response, "jetemail");

      if (message.sendAt !== undefined) {
        const acknowledgement = yield* Schema.decodeUnknownEffect(JetemailScheduledAcknowledgement)(
          body,
        ).pipe(Effect.mapError(invalid));

        if (acknowledgement.scheduled_at * 1000 !== DateTime.toEpochMillis(message.sendAt)) {
          return yield* invalid();
        }

        return Object.freeze(
          EmailReceiptSchema.cases.Accepted.make({
            messageId: acknowledgement.id,
            provider: "jetemail",
          }),
        );
      }

      const acknowledgement = yield* Schema.decodeUnknownEffect(JetemailImmediateAcknowledgement)(
        body,
      ).pipe(Effect.mapError(invalid));

      return Object.freeze(
        EmailReceiptSchema.cases.Accepted.make({
          messageId: acknowledgement.id,
          provider: "jetemail",
        }),
      );
    });

    return {
      capabilities: jetemailEmailCapabilities,
      idempotency: EmailSenderIdempotencySchema.cases.KeyForwarding.make({ maxKeyLength: 256 }),
      provider: "jetemail",
      request,
      respond,
      span: "JetEmail.submit",
      validate,
    };
  });

export const jetemailEmailLayer = (
  options: JetemailEmailOptions,
  policy?: EmailDeliveryPolicy,
  observer?: EmailRetryObserver,
  restriction?: EmailRetryRestriction,
): Layer.Layer<Email, EmailConfigurationError, HttpClient.HttpClient> =>
  emailLayer(policy, observer, restriction).pipe(Layer.provide(jetemailSenderLayer(options)));
