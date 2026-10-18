import { Effect, Layer, Option, Redacted, Schema } from "effect";
import { HttpClientRequest } from "effect/http";
import type { HttpClient, HttpClientResponse } from "effect/http";
import { EmailAddressSchema } from "./email-address.js";
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
import { EmailMessageIdSchema, EmailReceiptSchema } from "./email-message.js";
import type { EmailMessage, EmailReceipt } from "./email-message.js";
import {
  emailRecipientAddresses,
  parseEmailRecipientCoverage,
  partitionEmailSuppressions,
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
import { parseEmailPartialSuppressionReceipt } from "./email-suppression-receipt.js";

export const cloudflareEmailCapabilities = ownEmailSenderCapabilities(
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

export interface CloudflareEmailOptions {
  readonly accountId: string;
  readonly apiToken: Redacted.Redacted;
  readonly mailFlow: "ProviderUnmodified";
}

const CloudflareConfiguration = Schema.Struct({
  accountId: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/u)),
  apiToken: EmailHttpCredentialSchema,
  mailFlow: Schema.Literal("ProviderUnmodified"),
});

const CloudflareRecipientEvidence = Schema.Array(EmailAddressSchema).check(Schema.isMaxLength(50));

const CloudflareAcknowledgement = Schema.Struct({
  errors: Schema.Array(Schema.Never),
  messages: Schema.Array(Schema.Never),
  result: Schema.Struct({
    delivered: CloudflareRecipientEvidence,
    message_id: Schema.optionalKey(EmailMessageIdSchema),
    permanent_bounces: Schema.Array(Schema.Never),
    queued: CloudflareRecipientEvidence,
    suppressed_recipients: Schema.optionalKey(CloudflareRecipientEvidence),
  }),
  success: Schema.Literal(true),
});

const CloudflareProblem = Schema.Struct({
  errors: Schema.Tuple([
    Schema.Struct({
      code: Schema.Literals([10_101, 10_103, 10_102, 10_105, 10_203, 10_004]),
      message: Schema.Literals([
        "email.sending.error.authentication.unauthorized",
        "email.sending.error.authentication.bad_token_type",
        "email.sending.error.authentication.forbidden",
        "email.sending.error.authentication.not_entitled",
        "email.sending.error.email.sending_disabled",
        "email.sending.error.throttled",
      ]),
    }),
  ]),
  messages: Schema.Array(Schema.Never),
  result: Schema.Null,
  success: Schema.Literal(false),
});

const CloudflareRefusalEvidence = [
  { code: 10_101, message: "email.sending.error.authentication.unauthorized", status: 401 },
  { code: 10_103, message: "email.sending.error.authentication.bad_token_type", status: 401 },
  { code: 10_102, message: "email.sending.error.authentication.forbidden", status: 403 },
  { code: 10_105, message: "email.sending.error.authentication.not_entitled", status: 403 },
  { code: 10_203, message: "email.sending.error.email.sending_disabled", status: 403 },
  { code: 10_004, message: "email.sending.error.throttled", status: 429 },
] as const;

const CloudflareCustomHeaderName = Schema.String.check(
  Schema.isPattern(
    /^(?:x-[a-z0-9_-]+|in-reply-to|references|thread-index|thread-topic|keywords|comments|organization)$/iu,
  ),
);

const buildCloudflareMessage = (message: EmailMessage) => ({
  attachments: message.attachments?.map((attachment) => ({
    content: attachment.contentBase64,
    content_id: attachment.contentId,
    disposition: attachment.contentId === undefined ? "attachment" : "inline",
    filename: attachment.filename,
    type: attachment.contentType,
  })),
  bcc: message.bcc,
  cc: message.cc,
  from: message.from,
  headers:
    message.headers === undefined
      ? undefined
      : Object.fromEntries(message.headers.map(({ name, value }) => [name, value])),
  html: message.body.html,
  reply_to: message.replyTo?.[0],
  subject: message.subject,
  text: message.body.text,
  to: message.to,
});

const parseCloudflareRejection = Effect.fnUntraced(function* parseCloudflareRejection(
  response: HttpClientResponse.HttpClientResponse,
): Effect.fn.Return<never, EmailSubmissionError> {
  const { status } = response;

  if (status !== 401 && status !== 403 && status !== 429) {
    return yield* new EmailDeliveryUnknown({
      provider: "cloudflare",
      reason: status >= 500 ? "server-error" : "unexpected-status",
      status,
    });
  }

  const invalid = () =>
    new EmailDeliveryUnknown({ provider: "cloudflare", reason: "invalid-response", status });

  const problem = yield* readEmailHttpJson(response, "cloudflare").pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(CloudflareProblem, { onExcessProperty: "error" })),
    Effect.mapError(invalid),
  );

  const [error] = problem.errors;

  if (
    !CloudflareRefusalEvidence.some(
      (proof) =>
        proof.status === status && proof.code === error.code && proof.message === error.message,
    )
  ) {
    return yield* invalid();
  }

  if (status === 429) {
    return yield* Option.match(parseEmailHttpRetryAfterMillis(response.headers["retry-after"]), {
      onNone: () => new EmailRejected({ provider: "cloudflare", reason: "rate-limited", status }),
      onSome: (retryAfterMillis) =>
        new EmailRejected({
          provider: "cloudflare",
          reason: "rate-limited",
          retryAfterMillis,
          status,
        }),
    });
  }

  return yield* new EmailRejected({ provider: "cloudflare", reason: "authentication", status });
});

export const cloudflareSenderLayer = (
  options: CloudflareEmailOptions,
): Layer.Layer<EmailSender, EmailConfigurationError, HttpClient.HttpClient> =>
  emailHttpSenderLayer(CloudflareConfiguration, options, (configuration) => {
    const validate = Effect.fnUntraced(function* validateCloudflareIntent(
      message: EmailMessage,
    ): Effect.fn.Return<void, EmailInvalidMessage> {
      yield* validateEmailCapabilities(message, cloudflareEmailCapabilities);
      const issues: string[] = [];
      const recipients = emailRecipientAddresses(message).map((address) => address.toLowerCase());

      if (new Set(recipients).size !== recipients.length) {
        issues.push("to");
      }

      if ((message.replyTo?.length ?? 0) > 1) {
        issues.push("replyTo");
      }

      if (
        message.headers?.some(
          ({ name, value }) =>
            !Schema.is(CloudflareCustomHeaderName)(name) ||
            /^(?:x-cf-|x-cloudflare-|x-auth-)/iu.test(name) ||
            new TextEncoder().encode(value).byteLength > 2048,
        ) === true ||
        (message.headers?.reduce(
          (bytes, { name, value }) =>
            bytes +
            new TextEncoder().encode(name).byteLength +
            new TextEncoder().encode(value).byteLength +
            4,
          0,
        ) ?? 0) > 16_000
      ) {
        issues.push("headers");
      }

      if (
        new TextEncoder().encode(JSON.stringify(buildCloudflareMessage(message))).byteLength >
        4_000_000
      ) {
        issues.push("body");
      }

      if (issues.length > 0) {
        return yield* new EmailInvalidMessage({
          issues: [...new Set(issues)].map((path) => ({
            path,
            problem: "Cloudflare cannot preserve this constrained transactional intent",
          })),
        });
      }

      return undefined;
    });

    const request = Effect.fnUntraced(function* buildCloudflareRequest(
      submission: EmailSubmission,
    ): Effect.fn.Return<HttpClientRequest.HttpClientRequest, EmailRejected> {
      return yield* HttpClientRequest.post(
        `https://api.cloudflare.com/client/v4/accounts/${configuration.accountId}/email/sending/send`,
      ).pipe(
        HttpClientRequest.bearerToken(Redacted.value(configuration.apiToken)),
        HttpClientRequest.acceptJson,
        HttpClientRequest.bodyJson(buildCloudflareMessage(submission.message)),
        Effect.mapError(
          () => new EmailRejected({ provider: "cloudflare", reason: "invalid-message" }),
        ),
      );
    });

    const respond = Effect.fnUntraced(function* parseCloudflareAcknowledgement(
      response: HttpClientResponse.HttpClientResponse,
      message: EmailMessage,
    ): Effect.fn.Return<EmailReceipt, EmailSubmissionError> {
      const { status } = response;

      if (status !== 200) {
        return yield* parseCloudflareRejection(response);
      }

      const invalid = () =>
        new EmailDeliveryUnknown({ provider: "cloudflare", reason: "invalid-response", status });

      const acknowledgement = yield* readEmailHttpJson(response, "cloudflare").pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(CloudflareAcknowledgement, { onExcessProperty: "error" }),
        ),
        Effect.mapError(invalid),
      );

      const { result } = acknowledgement;
      const suppressed = result.suppressed_recipients ?? [];
      yield* parseEmailRecipientCoverage(
        message,
        [...result.delivered, ...result.queued, ...suppressed],
        "cloudflare",
        status,
      );

      if (suppressed.length > 0) {
        const partition = yield* partitionEmailSuppressions(
          message,
          suppressed,
          "cloudflare",
          status,
        );

        if (partition.accepted.length === 0) {
          const receipt = EmailReceiptSchema.cases.Suppressed.make({
            provider: "cloudflare",
            suppressed: partition.suppressed,
          });

          Object.freeze(receipt.suppressed);

          return Object.freeze(receipt);
        }

        return yield* parseEmailPartialSuppressionReceipt(
          partition,
          "cloudflare",
          status,
          result.message_id,
        );
      }

      return Object.freeze(
        result.message_id === undefined
          ? EmailReceiptSchema.cases.Accepted.make({ provider: "cloudflare" })
          : EmailReceiptSchema.cases.Accepted.make({
              messageId: result.message_id,
              provider: "cloudflare",
            }),
      );
    });

    return {
      capabilities: cloudflareEmailCapabilities,
      idempotency: EmailSenderIdempotencySchema.cases.None.make({}),
      provider: "cloudflare",
      request,
      respond,
      span: "Cloudflare.submit",
      validate,
    };
  });

export const cloudflareEmailLayer = (
  options: CloudflareEmailOptions,
  policy?: EmailDeliveryPolicy,
  observer?: EmailRetryObserver,
  restriction?: EmailRetryRestriction,
): Layer.Layer<Email, EmailConfigurationError, HttpClient.HttpClient> =>
  emailLayer(policy, observer, restriction).pipe(Layer.provide(cloudflareSenderLayer(options)));
