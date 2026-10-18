import { DateTime, Duration, Effect, Layer, Match, Option, Redacted, Schema } from "effect";
import { HttpClientRequest } from "effect/http";
import type { HttpClient, HttpClientResponse } from "effect/http";
import { EmailAddressSchema, emailMailboxAddress } from "./email-address.js";
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
import { emailInputIssues } from "./email-input-issues.js";
import { EmailMessageIdSchema, EmailReceiptSchema } from "./email-message.js";
import type { EmailMessage, EmailReceipt } from "./email-message.js";
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

export const sendheronEmailCapabilities = ownEmailSenderCapabilities(
  EmailSenderCapabilitiesSchema.make({
    attachmentContentTypes: "Explicit",
    attachments: true,
    headers: "Unique",
    inlineAttachments: false,
    metadata: false,
    scheduling: true,
    tags: { asciiOnly: false, maxCount: 0 },
  }),
);

const sendheronAttachmentlessCapabilities = ownEmailSenderCapabilities(
  EmailSenderCapabilitiesSchema.make({
    ...sendheronEmailCapabilities,
    attachmentContentTypes: "None",
    attachments: false,
  }),
);

const SendheronConfiguration = Schema.Struct({
  apiKey: EmailHttpCredentialSchema,
  attachments: Schema.optionalKey(Schema.Literals(["Enabled", "Disabled"])),
  submissionMode: Schema.Literal("TransactionalOnly"),
  tracking: Schema.Literal("AuthorizeProviderTracking"),
});

export type SendheronEmailOptions = typeof SendheronConfiguration.Type;

const SendheronSent = Schema.Struct({
  errorMessage: Schema.optionalKey(Schema.Null),
  from: EmailAddressSchema,
  id: EmailMessageIdSchema,
  status: Schema.Literal("sent"),
  subject: Schema.String,
  to: EmailAddressSchema,
});

const SendheronSuppressed = Schema.Struct({
  errorMessage: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  id: EmailMessageIdSchema,
  status: Schema.Literal("suppressed"),
  to: EmailAddressSchema,
});

const SendheronScheduled = Schema.Struct({
  errorMessage: Schema.optionalKey(Schema.Null),
  id: EmailMessageIdSchema,
  sendAt: Schema.DateTimeUtcFromString,
  status: Schema.Literal("SCHEDULED"),
});

const SendheronProblem = Schema.Struct({
  message: Schema.String.check(Schema.isMaxLength(128)),
  statusCode: Schema.Int,
});

const attachmentTypes = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "text/calendar",
  "text/csv",
  "text/plain",
  "application/zip",
]);

const SendheronRepresentableIntent = Schema.Struct({
  bcc: Schema.optionalKey(Schema.Never),
  body: Schema.Struct({ html: Schema.String, text: Schema.optionalKey(Schema.Never) }),
  cc: Schema.optionalKey(Schema.Never),
  from: Schema.Struct({
    address: EmailAddressSchema,
    name: Schema.String.check(Schema.isMaxLength(100), Schema.isPattern(/^[^<>]*$/u)),
  }),
  replyTo: Schema.Tuple([EmailAddressSchema]),
  to: Schema.Tuple([EmailAddressSchema]),
});

const validateSendheronIntent = Effect.fnUntraced(function* validateSendheronIntent(
  message: EmailMessage,
): Effect.fn.Return<void, EmailInvalidMessage> {
  yield* Schema.decodeUnknownEffect(SendheronRepresentableIntent)(message).pipe(
    Effect.mapError((cause) => new EmailInvalidMessage({ issues: emailInputIssues(cause) })),
  );
  const issues = [];

  if (message.attachments !== undefined && message.sendAt !== undefined) {
    issues.push({ path: "attachments", problem: "SendHeron cannot schedule attachment bytes" });
  }

  if (
    message.attachments?.some(
      (attachment) => !attachmentTypes.has(emailAttachmentMimeType(attachment) ?? ""),
    ) === true
  ) {
    issues.push({
      path: "attachments.contentType",
      problem: "SendHeron requires a documented allowed attachment MIME type",
    });
  }

  if (
    message.headers?.some(
      ({ name }) =>
        !/^x-[a-z0-9-]+$/iu.test(name) || /^(?:x-sendheron-|x-idempotency)/iu.test(name),
    ) === true
  ) {
    issues.push({
      path: "headers",
      problem: "SendHeron permits only non-control custom X headers in this slice",
    });
  }

  if (issues.length > 0) {
    return yield* new EmailInvalidMessage({ issues });
  }

  return undefined;
});

const classifySendheronFailure = Effect.fnUntraced(function* classifySendheronFailure(
  response: HttpClientResponse.HttpClientResponse,
): Effect.fn.Return<never, EmailSubmissionError> {
  const { status } = response;

  if (status === 429) {
    return yield* Option.match(parseEmailHttpRetryAfterMillis(response.headers["retry-after"]), {
      onNone: () => new EmailRejected({ provider: "sendheron", reason: "rate-limited", status }),
      onSome: (retryAfterMillis) =>
        new EmailRejected({
          provider: "sendheron",
          reason: "rate-limited",
          retryAfterMillis,
          status,
        }),
    });
  }

  if (status === 503) {
    const problem = yield* readEmailHttpJson(response, "sendheron").pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(SendheronProblem)),
      Effect.option,
    );

    if (
      Option.isSome(problem) &&
      problem.value.statusCode === status &&
      problem.value.message === "emailSending.sendFailed"
    ) {
      return yield* new EmailRejected({
        provider: "sendheron",
        reason: "temporarily-unavailable",
        status,
      });
    }
  }

  const reason = Match.value(status).pipe(
    Match.when(400, () => "invalid-message" as const),
    Match.when(401, () => "authentication" as const),
    Match.when(403, () => "rejected" as const),
    Match.orElse(() => "unexpected-status" as const),
  );

  if (reason === "unexpected-status") {
    return yield* new EmailDeliveryUnknown({
      provider: "sendheron",
      reason: status >= 500 ? "server-error" : reason,
      status,
    });
  }

  return yield* new EmailRejected({ provider: "sendheron", reason, status });
});

const readSendheronAcknowledgement = Effect.fnUntraced(function* readSendheronAcknowledgement(
  response: HttpClientResponse.HttpClientResponse,
  message: EmailMessage,
): Effect.fn.Return<EmailReceipt, EmailSubmissionError> {
  if (response.status !== 201) {
    return yield* classifySendheronFailure(response);
  }

  const invalid = () =>
    new EmailDeliveryUnknown({
      provider: "sendheron",
      reason: "invalid-response",
      status: response.status,
    });

  const json = yield* readEmailHttpJson(response, "sendheron");

  if (message.sendAt !== undefined) {
    const acknowledgement = yield* Schema.decodeUnknownEffect(SendheronScheduled)(json).pipe(
      Effect.mapError(invalid),
    );

    if (DateTime.toEpochMillis(acknowledgement.sendAt) !== DateTime.toEpochMillis(message.sendAt)) {
      return yield* invalid();
    }

    return Object.freeze(
      EmailReceiptSchema.cases.Accepted.make({
        messageId: acknowledgement.id,
        provider: "sendheron",
      }),
    );
  }

  const acknowledgement = yield* Schema.decodeUnknownEffect(
    Schema.Union([SendheronSent, SendheronSuppressed]),
  )(json).pipe(Effect.mapError(invalid));

  const [recipient] = message.to;

  if (acknowledgement.to.toLowerCase() !== emailMailboxAddress(recipient).toLowerCase()) {
    return yield* invalid();
  }

  if (acknowledgement.status === "suppressed") {
    const receipt = EmailReceiptSchema.cases.Suppressed.make({
      provider: "sendheron",
      suppressed: [emailMailboxAddress(recipient)],
    });

    Object.freeze(receipt.suppressed);

    return Object.freeze(receipt);
  }

  if (
    acknowledgement.from.toLowerCase() !== emailMailboxAddress(message.from).toLowerCase() ||
    acknowledgement.subject !== message.subject
  ) {
    return yield* invalid();
  }

  return Object.freeze(
    EmailReceiptSchema.cases.Accepted.make({
      messageId: acknowledgement.id,
      provider: "sendheron",
    }),
  );
});

export const sendheronSenderLayer = (
  options: SendheronEmailOptions,
): Layer.Layer<EmailSender, EmailConfigurationError, HttpClient.HttpClient> =>
  emailHttpSenderLayer(SendheronConfiguration, options, (configuration) => ({
    capabilities:
      configuration.attachments === "Disabled"
        ? sendheronAttachmentlessCapabilities
        : sendheronEmailCapabilities,
    idempotency:
      configuration.attachments === "Disabled"
        ? EmailSenderIdempotencySchema.cases.Native.make({
            maxKeyLength: 255,
            retention: Duration.hours(24),
          })
        : EmailSenderIdempotencySchema.cases.KeyForwarding.make({ maxKeyLength: 255 }),
    provider: "sendheron",
    request: Effect.fnUntraced(function* buildSendheronRequest(
      submission: EmailSubmission,
    ): Effect.fn.Return<HttpClientRequest.HttpClientRequest, EmailRejected> {
      const { message } = submission;

      const request = yield* HttpClientRequest.post(
        "https://api.sendheron.com/api/v1/emails/send",
      ).pipe(
        HttpClientRequest.bearerToken(Redacted.value(configuration.apiKey)),
        HttpClientRequest.acceptJson,
        HttpClientRequest.bodyJson({
          attachments: message.attachments?.map((attachment) => ({
            content: attachment.contentBase64,
            disposition: "attachment",
            filename: attachment.filename,
            type: emailAttachmentMimeType(attachment),
          })),
          from: emailMailboxAddress(message.from),
          fromName: Schema.is(EmailAddressSchema)(message.from) ? undefined : message.from.name,
          headers:
            message.headers === undefined
              ? undefined
              : Object.fromEntries(message.headers.map(({ name, value }) => [name, value])),
          html: message.body.html,
          replyTo: message.replyTo?.map(emailMailboxAddress)[0],
          sendAt: message.sendAt === undefined ? undefined : DateTime.formatIso(message.sendAt),
          subject: message.subject,
          to: emailMailboxAddress(message.to[0]),
        }),
        Effect.mapError(
          () => new EmailRejected({ provider: "sendheron", reason: "invalid-message" }),
        ),
      );

      return submission.idempotencyKey === undefined
        ? request
        : HttpClientRequest.setHeader(request, "idempotency-key", submission.idempotencyKey);
    }),
    respond: readSendheronAcknowledgement,
    span: "Sendheron.submit",
    validate: (message) =>
      validateEmailCapabilities(
        message,
        configuration.attachments === "Disabled"
          ? sendheronAttachmentlessCapabilities
          : sendheronEmailCapabilities,
      ).pipe(Effect.andThen(validateSendheronIntent(message))),
  }));

export const sendheronEmailLayer = (
  options: SendheronEmailOptions,
  policy?: EmailDeliveryPolicy,
  observer?: EmailRetryObserver,
  restriction?: EmailRetryRestriction,
): Layer.Layer<Email, EmailConfigurationError, HttpClient.HttpClient> =>
  emailLayer(policy, observer, restriction).pipe(Layer.provide(sendheronSenderLayer(options)));
