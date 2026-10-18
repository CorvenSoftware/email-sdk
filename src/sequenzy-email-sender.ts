import { Duration, Effect, Layer, Redacted, Schema } from "effect";
import { HttpClientRequest } from "effect/http";
import type { HttpClient, HttpClientResponse } from "effect/http";
import {
  EmailAddressSchema,
  EmailMailboxSchema,
  emailMailboxAddress,
  formatEmailMailbox,
} from "./email-address.js";
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
import { emailInputIssues } from "./email-input-issues.js";
import { EmailInvalidMessage } from "./email-invalid-message.js";
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

export const sequenzyEmailCapabilities = ownEmailSenderCapabilities(
  EmailSenderCapabilitiesSchema.make({
    attachmentContentTypes: "Both",
    attachments: true,
    headers: "None",
    inlineAttachments: false,
    metadata: false,
    scheduling: false,
    tags: { asciiOnly: false, maxCount: 0 },
  }),
);

const SequenzyConfiguration = Schema.Struct({
  apiKey: EmailHttpCredentialSchema,
  automaticUtm: Schema.Literal("AccountDisabled"),
  contactWrites: Schema.Literal("AuthorizeProviderManagedProfiles"),
  contentAuthority: Schema.Literal("AuthorizeProviderRenderingAndRetention"),
  replyTracking: Schema.Literal("AccountDisabled"),
  senderIdentity: Schema.Literal("ExistingVerifiedProfile"),
  submissionMode: Schema.Literal("TransactionalOnly"),
});

export type SequenzyEmailOptions = typeof SequenzyConfiguration.Type;

const SequenzyRepresentableIntent = Schema.Struct({
  bcc: Schema.optionalKey(Schema.NonEmptyArray(EmailAddressSchema)),
  body: Schema.Struct({ html: Schema.String, text: Schema.optionalKey(Schema.Never) }),
  cc: Schema.optionalKey(Schema.NonEmptyArray(EmailAddressSchema)),
  from: Schema.Struct({ address: EmailAddressSchema, name: Schema.String }),
  replyTo: Schema.Tuple([Schema.toType(EmailMailboxSchema)]),
  to: Schema.NonEmptyArray(EmailAddressSchema),
});

const SequenzyAcknowledgement = Schema.Struct({
  bcc: Schema.optionalKey(Schema.Array(EmailAddressSchema)),
  cc: Schema.optionalKey(Schema.Array(EmailAddressSchema)),
  code: Schema.optionalKey(Schema.Never),
  diagnostics: Schema.optionalKey(Schema.Never),
  emailSendId: EmailMessageIdSchema,
  emailType: Schema.optionalKey(Schema.Literal("transactional")),
  error: Schema.optionalKey(Schema.Never),
  ignoredHeaders: Schema.optionalKey(Schema.Tuple([])),
  success: Schema.Literal(true),
  to: Schema.Union([EmailAddressSchema, Schema.NonEmptyArray(EmailAddressSchema)]),
  transactional: Schema.optionalKey(Schema.Never),
});

const SequenzyKeyConflict = Schema.Struct({
  code: Schema.Literal("IDEMPOTENCY_KEY_REUSED"),
  success: Schema.Literal(false),
});

const validateSequenzyIntent = Effect.fnUntraced(function* validateSequenzyIntent(
  message: EmailMessage,
): Effect.fn.Return<void, EmailInvalidMessage> {
  yield* validateEmailCapabilities(message, sequenzyEmailCapabilities);
  yield* Schema.decodeUnknownEffect(SequenzyRepresentableIntent)(message).pipe(
    Effect.mapError((cause) => new EmailInvalidMessage({ issues: emailInputIssues(cause) })),
  );

  const recipients = [...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])].map((mailbox) =>
    emailMailboxAddress(mailbox).toLowerCase(),
  );

  if (new Set(recipients).size !== recipients.length) {
    return yield* new EmailInvalidMessage({
      issues: [
        {
          path: "to",
          problem:
            "Sequenzy removes duplicate recipients; supply distinct identities across every group",
        },
      ],
    });
  }

  return undefined;
});

const sameSequenzyRecipients = (actual: readonly string[], expected: readonly string[]) =>
  actual.length === expected.length &&
  actual.every((address, index) => address.toLowerCase() === expected[index]?.toLowerCase());

const readSequenzyAcknowledgement = Effect.fnUntraced(function* readSequenzyAcknowledgement(
  response: HttpClientResponse.HttpClientResponse,
  message: EmailMessage,
): Effect.fn.Return<EmailReceipt, EmailSubmissionError> {
  const invalid = () =>
    new EmailDeliveryUnknown({
      provider: "sequenzy",
      reason: "invalid-response",
      status: response.status,
    });

  if (response.status === 200) {
    const json = yield* readEmailHttpJson(response, "sequenzy");

    const acknowledgement = yield* Schema.decodeUnknownEffect(SequenzyAcknowledgement)(json).pipe(
      Effect.mapError(invalid),
    );

    const to = Schema.is(EmailAddressSchema)(acknowledgement.to)
      ? [acknowledgement.to]
      : acknowledgement.to;

    if (
      !sameSequenzyRecipients(to, message.to.map(emailMailboxAddress)) ||
      !sameSequenzyRecipients(
        acknowledgement.cc ?? [],
        (message.cc ?? []).map(emailMailboxAddress),
      ) ||
      !sameSequenzyRecipients(
        acknowledgement.bcc ?? [],
        (message.bcc ?? []).map(emailMailboxAddress),
      )
    ) {
      return yield* invalid();
    }

    return Object.freeze(
      EmailReceiptSchema.cases.Accepted.make({
        messageId: acknowledgement.emailSendId,
        provider: "sequenzy",
      }),
    );
  }

  if (response.status === 409) {
    const json = yield* readEmailHttpJson(response, "sequenzy");
    yield* Schema.decodeUnknownEffect(SequenzyKeyConflict)(json).pipe(Effect.mapError(invalid));

    return yield* new EmailRejected({
      provider: "sequenzy",
      reason: "idempotency-conflict",
      status: response.status,
    });
  }

  if (response.status === 401) {
    return yield* new EmailRejected({
      provider: "sequenzy",
      reason: "authentication",
      status: response.status,
    });
  }

  if (response.status === 400) {
    const json = yield* readEmailHttpJson(response, "sequenzy");
    yield* Schema.decodeUnknownEffect(Schema.Struct({ success: Schema.Literal(false) }))(json).pipe(
      Effect.mapError(invalid),
    );

    return yield* new EmailRejected({
      provider: "sequenzy",
      reason: "invalid-message",
      status: response.status,
    });
  }

  return yield* new EmailDeliveryUnknown({
    provider: "sequenzy",
    reason: response.status >= 500 ? "server-error" : "unexpected-status",
    status: response.status,
  });
});

export const sequenzySenderLayer = (
  options: SequenzyEmailOptions,
): Layer.Layer<EmailSender, EmailConfigurationError, HttpClient.HttpClient> =>
  emailHttpSenderLayer(SequenzyConfiguration, options, (configuration) => ({
    capabilities: sequenzyEmailCapabilities,
    idempotency: EmailSenderIdempotencySchema.cases.Native.make({
      maxKeyLength: 255,
      retention: Duration.days(14),
    }),
    provider: "sequenzy",
    request: Effect.fnUntraced(function* buildSequenzyRequest(
      submission: EmailSubmission,
    ): Effect.fn.Return<HttpClientRequest.HttpClientRequest, EmailRejected> {
      const { message } = submission;

      const request = yield* HttpClientRequest.post(
        "https://api.sequenzy.com/api/v1/transactional/send",
      ).pipe(
        HttpClientRequest.bearerToken(Redacted.value(configuration.apiKey)),
        HttpClientRequest.acceptJson,
        HttpClientRequest.bodyJson({
          attachments: message.attachments?.map((attachment) => ({
            content: attachment.contentBase64,
            contentType: emailAttachmentMimeType(attachment),
            filename: attachment.filename,
          })),
          bcc: message.bcc?.map(emailMailboxAddress),
          body: message.body.html,
          cc: message.cc?.map(emailMailboxAddress),
          emailType: "transactional",
          fromEmail: emailMailboxAddress(message.from),
          fromName: Schema.is(EmailAddressSchema)(message.from) ? undefined : message.from.name,
          replyTo: message.replyTo?.map(formatEmailMailbox)[0],
          subject: message.subject,
          to: message.to.map(emailMailboxAddress),
          trackingSettings: { clickTracking: false, openTracking: false },
        }),
        Effect.mapError(
          () => new EmailRejected({ provider: "sequenzy", reason: "invalid-message" }),
        ),
      );

      return submission.idempotencyKey === undefined
        ? request
        : HttpClientRequest.setHeader(request, "Idempotency-Key", submission.idempotencyKey);
    }),
    respond: readSequenzyAcknowledgement,
    span: "Sequenzy.submit",
    validate: validateSequenzyIntent,
  }));

export const sequenzyEmailLayer = (
  options: SequenzyEmailOptions,
  policy?: EmailDeliveryPolicy,
  observer?: EmailRetryObserver,
  restriction?: EmailRetryRestriction,
): Layer.Layer<Email, EmailConfigurationError, HttpClient.HttpClient> =>
  emailLayer(policy, observer, restriction).pipe(Layer.provide(sequenzySenderLayer(options)));
