import { Effect, Layer, Match, Option, Redacted, Schema } from "effect";
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
import { parseEmailCountedReceipt } from "./email-counted-receipt.js";
import { EmailDeliveryUnknown } from "./email-delivery-unknown.js";
import type { EmailSubmissionError } from "./email-errors.js";
import { EmailHttpCredentialTextSchema } from "./email-http-credential.js";
import { emailHttpSenderLayer } from "./email-http-protocol.js";
import { readEmailHttpJson } from "./email-http-response.js";
import { parseEmailHttpRetryAfterMillis } from "./email-http-retry-after.js";
import { EmailInvalidMessage } from "./email-invalid-message.js";
import { EmailMessageIdSchema } from "./email-message.js";
import type { EmailMessage, EmailReceipt } from "./email-message.js";
import {
  emailRecipientAddresses,
  parseEmailRecipientCoverage,
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

export const primitiveEmailCapabilities = ownEmailSenderCapabilities(
  EmailSenderCapabilitiesSchema.make({
    attachmentContentTypes: "Both",
    attachments: true,
    headers: "Unique",
    inlineAttachments: true,
    metadata: false,
    scheduling: false,
    tags: { asciiOnly: true, maxCount: 0 },
  }),
);

export interface PrimitiveEmailOptions {
  readonly apiKey: Redacted.Redacted;
  readonly keylessSends: "Reject" | "AllowContentDeduplication";
  readonly tracking: "ProviderDisabled";
}

const PrimitiveConfiguration = Schema.Struct({
  apiKey: Schema.Redacted(
    EmailHttpCredentialTextSchema.check(Schema.isPattern(/^prim_(?!oat_).+$/u)),
  ),
  keylessSends: Schema.Literals(["Reject", "AllowContentDeduplication"]),
  tracking: Schema.Literal("ProviderDisabled"),
});

const PrimitiveFreshMarkers = {
  dedup_reason: Schema.optionalKey(Schema.Null),
  idempotency: Schema.optionalKey(Schema.Null),
  idempotent_replay: Schema.optionalKey(Schema.Literal(false)),
};

const PrimitiveAcknowledgement = Schema.Struct({
  ...PrimitiveFreshMarkers,
  data: Schema.Struct({
    ...PrimitiveFreshMarkers,
    accepted: Schema.Array(EmailAddressSchema).check(Schema.isMaxLength(50)),
    delivery_status: Schema.optionalKey(Schema.Null),
    id: EmailMessageIdSchema.check(Schema.isUUID()),
    idempotent_replay: Schema.Literal(false),
    queue_id: EmailMessageIdSchema,
    rejected: Schema.Array(EmailAddressSchema).check(Schema.isMaxLength(50)),
    scheduled_at: Schema.optionalKey(Schema.Null),
    status: Schema.Literal("submitted_to_agent"),
  }),
  error: Schema.optionalKey(Schema.Null),
  success: Schema.Literal(true),
});

const PrimitiveProblem = Schema.Struct({
  ...PrimitiveFreshMarkers,
  data: Schema.optionalKey(Schema.Null),
  error: Schema.Struct({
    ...PrimitiveFreshMarkers,
    code: Schema.String.check(Schema.isMaxLength(128)),
    details: Schema.optionalKey(Schema.Struct(PrimitiveFreshMarkers)),
  }),
  success: Schema.Literal(false),
});

const PrimitiveHeaderName = Schema.String.check(
  Schema.makeFilter((name) =>
    ["auto-submitted", "x-auto-response-suppress", "precedence"].includes(name.toLowerCase()),
  ),
);

const PrimitiveHeaderValue = Schema.String.check(
  Schema.isMaxLength(200),
  Schema.isPattern(/^[\u0020-\u007E]*$/u),
);

const parsePrimitiveRecipientReceipt = Effect.fnUntraced(function* parsePrimitiveRecipientReceipt(
  message: EmailMessage,
  data: (typeof PrimitiveAcknowledgement.Type)["data"],
  status: number,
): Effect.fn.Return<EmailReceipt, EmailDeliveryUnknown> {
  yield* parseEmailRecipientCoverage(
    message,
    [...data.accepted, ...data.rejected],
    "primitive",
    status,
  );

  if (data.accepted.length === 0) {
    return yield* new EmailDeliveryUnknown({
      provider: "primitive",
      reason: "invalid-response",
      status,
    });
  }

  return yield* parseEmailCountedReceipt(
    message,
    { acceptedCount: data.accepted.length, rejectedCount: data.rejected.length },
    "primitive",
    status,
    data.id,
  );
});

const classifyPrimitiveRejection = Effect.fnUntraced(function* classifyPrimitiveRejection(
  response: HttpClientResponse.HttpClientResponse,
): Effect.fn.Return<never, EmailSubmissionError> {
  const { status } = response;

  if (![400, 401, 403, 429].includes(status)) {
    return yield* new EmailDeliveryUnknown({
      provider: "primitive",
      reason: status >= 500 ? "server-error" : "unexpected-status",
      status,
    });
  }

  const problem = yield* readEmailHttpJson(response, "primitive").pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(PrimitiveProblem)),
    Effect.mapError(
      () => new EmailDeliveryUnknown({ provider: "primitive", reason: "invalid-response", status }),
    ),
  );

  const reason = Match.value({ code: problem.error.code, status }).pipe(
    Match.when({ code: "unauthorized", status: 401 }, () => "authentication" as const),
    Match.when({ code: "validation_error", status: 400 }, () => "invalid-message" as const),
    Match.when(
      {
        code: Match.is("forbidden", "recipient_not_allowed", "cannot_send_from_domain"),
        status: 403,
      },
      () => "rejected" as const,
    ),
    Match.when(
      { code: Match.is("rate_limited", "rate_limit_exceeded"), status: 429 },
      () => "rate-limited" as const,
    ),
    Match.orElse(() => "invalid-response" as const),
  );

  if (reason === "invalid-response") {
    return yield* new EmailDeliveryUnknown({ provider: "primitive", reason, status });
  }

  if (reason !== "rate-limited") {
    return yield* new EmailRejected({ provider: "primitive", reason, status });
  }

  return yield* Option.match(parseEmailHttpRetryAfterMillis(response.headers["retry-after"]), {
    onNone: () => new EmailRejected({ provider: "primitive", reason, status }),
    onSome: (retryAfterMillis) =>
      new EmailRejected({ provider: "primitive", reason, retryAfterMillis, status }),
  });
});

export const primitiveSenderLayer = (
  options: PrimitiveEmailOptions,
): Layer.Layer<EmailSender, EmailConfigurationError, HttpClient.HttpClient> =>
  emailHttpSenderLayer(PrimitiveConfiguration, options, (configuration) => {
    const validate = Effect.fnUntraced(function* validatePrimitiveIntent(
      message: EmailMessage,
    ): Effect.fn.Return<void, EmailInvalidMessage> {
      yield* validateEmailCapabilities(message, primitiveEmailCapabilities);

      const issues: string[] = [];
      const addresses = emailRecipientAddresses(message).map((address) => address.toLowerCase());

      if (
        message.to.length !== 1 ||
        new Set(addresses).size !== addresses.length ||
        [...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])].some(
          (mailbox) => !Schema.is(EmailAddressSchema)(mailbox) && mailbox.name !== undefined,
        )
      ) {
        issues.push("to");
      }

      if (message.replyTo !== undefined) {
        issues.push("replyTo");
      }

      if (
        new TextEncoder().encode(message.body.text ?? "").byteLength +
          new TextEncoder().encode(message.body.html ?? "").byteLength >
        262_144
      ) {
        issues.push("body");
      }

      if (
        message.headers?.some(
          ({ name, value }) =>
            !Schema.is(PrimitiveHeaderName)(name) || !Schema.is(PrimitiveHeaderValue)(value),
        ) === true
      ) {
        issues.push("headers");
      }

      if (issues.length > 0) {
        return yield* new EmailInvalidMessage({
          issues: issues.map((path) => ({
            path,
            problem:
              "Primitive cannot preserve this intent in the constrained immediate submission",
          })),
        });
      }

      return undefined;
    });

    const request = Effect.fnUntraced(function* buildPrimitiveRequest(
      submission: EmailSubmission,
    ): Effect.fn.Return<HttpClientRequest.HttpClientRequest, EmailRejected> {
      const { message } = submission;
      const [recipient] = message.to;

      const httpRequest = HttpClientRequest.post("https://api.primitive.dev/v1/send-mail").pipe(
        HttpClientRequest.bearerToken(Redacted.value(configuration.apiKey)),
        HttpClientRequest.acceptJson,
      );

      return yield* HttpClientRequest.bodyJson(
        submission.idempotencyKey === undefined
          ? httpRequest
          : HttpClientRequest.setHeader(httpRequest, "Idempotency-Key", submission.idempotencyKey),
        {
          attachments: message.attachments?.map((attachment) => ({
            content_base64: attachment.contentBase64,
            content_id: attachment.contentId,
            content_type: emailAttachmentMimeType(attachment),
            filename: attachment.filename,
          })),
          bcc: message.bcc?.map(formatEmailMailbox),
          body_html: message.body.html,
          body_text: message.body.text,
          cc: message.cc?.map(formatEmailMailbox),
          from: formatEmailMailbox(message.from),
          headers:
            message.headers === undefined
              ? undefined
              : Object.fromEntries(message.headers.map(({ name, value }) => [name, value])),
          subject: message.subject,
          to: formatEmailMailbox(recipient),
          wait: false,
        },
      ).pipe(
        Effect.mapError(
          () => new EmailRejected({ provider: "primitive", reason: "invalid-message" }),
        ),
      );
    });

    const respond = Effect.fnUntraced(function* readPrimitiveAcknowledgement(
      response: HttpClientResponse.HttpClientResponse,
      message: EmailMessage,
    ): Effect.fn.Return<EmailReceipt, EmailSubmissionError> {
      if (response.headers["idempotent-replayed"] !== undefined) {
        return yield* new EmailDeliveryUnknown({
          provider: "primitive",
          reason: "invalid-response",
          status: response.status,
        });
      }

      if (response.status !== 200) {
        return yield* classifyPrimitiveRejection(response);
      }

      const acknowledgement = yield* readEmailHttpJson(response, "primitive").pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(PrimitiveAcknowledgement)),
        Effect.mapError(
          () =>
            new EmailDeliveryUnknown({
              provider: "primitive",
              reason: "invalid-response",
              status: response.status,
            }),
        ),
      );

      return yield* parsePrimitiveRecipientReceipt(message, acknowledgement.data, response.status);
    });

    return {
      capabilities: primitiveEmailCapabilities,
      idempotency: EmailSenderIdempotencySchema.cases.KeyForwarding.make({
        keyRequirement: configuration.keylessSends === "Reject" ? "Required" : "Optional",
        maxKeyLength: 255,
      }),
      provider: "primitive",
      request,
      respond,
      span: "Primitive.submit",
      validate,
    };
  });

export const primitiveEmailLayer = (
  options: PrimitiveEmailOptions,
  policy?: EmailDeliveryPolicy,
  observer?: EmailRetryObserver,
  restriction?: EmailRetryRestriction,
): Layer.Layer<Email, EmailConfigurationError, HttpClient.HttpClient> =>
  emailLayer(policy, observer, restriction).pipe(Layer.provide(primitiveSenderLayer(options)));
