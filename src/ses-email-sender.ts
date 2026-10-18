import type { Redacted } from "effect";
import { DateTime, Effect, Layer, Option, Schema } from "effect";
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
import type { EmailMessage, EmailReceipt } from "./email-message.js";
import { emailRecipientAddresses } from "./email-recipient-outcomes.js";
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
import { signSesEmailRequest } from "./ses-request-signature.js";

export const sesEmailCapabilities = ownEmailSenderCapabilities(
  EmailSenderCapabilitiesSchema.make({
    attachmentContentTypes: "Explicit",
    attachments: true,
    headers: "Unique",
    inlineAttachments: true,
    metadata: false,
    scheduling: false,
    tags: { asciiOnly: true, maxCount: 50 },
  }),
);

export interface SesEmailOptions {
  readonly accessKeyId: Redacted.Redacted;
  readonly secretAccessKey: Redacted.Redacted;
  readonly sessionToken?: Redacted.Redacted;
  readonly region: "us-east-1" | "us-west-2" | "eu-west-1";
  readonly mailFlow: "ProviderUnmodified";
}

const SesConfiguration = Schema.Struct({
  accessKeyId: Schema.Redacted(
    EmailHttpCredentialTextSchema.check(Schema.isPattern(/^[A-Z0-9]{16,128}$/u)),
  ),
  mailFlow: Schema.Literal("ProviderUnmodified"),
  region: Schema.Literals(["us-east-1", "us-west-2", "eu-west-1"]),
  secretAccessKey: Schema.Redacted(EmailHttpCredentialTextSchema.check(Schema.isMaxLength(128))),
  sessionToken: Schema.optionalKey(
    Schema.Redacted(EmailHttpCredentialTextSchema.check(Schema.isMaxLength(16_384))),
  ),
});

const SesAcknowledgement = Schema.Struct({ MessageId: EmailMessageIdSchema });

const SesRefusalType = Schema.Literals([
  "AccessDeniedException",
  "ExpiredTokenException",
  "MailFromDomainNotVerifiedException",
  "AccountSuspendedException",
  "SendingPausedException",
  "TooManyRequestsException",
]);

const SesProblem = Schema.Struct({
  __type: Schema.optionalKey(SesRefusalType),
  message: Schema.optionalKey(Schema.String),
});

const SesAsciiText = Schema.String.check(
  Schema.isPattern(/^[\u0020-\u007E]*$/u),
  Schema.makeFilter((value) => !value.includes("=?"), {
    expected: "literal ASCII header text without encoded-word syntax",
  }),
);

const SesTagText = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/u));

const SesAttachmentExtension = Schema.Literals([
  "pdf",
  "txt",
  "csv",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "dat",
]);

const buildSesMessage = (message: EmailMessage) => ({
  ConfigurationOverrides: {
    Tracking: { ClickTrackingEnabled: "DISABLED", OpenTrackingEnabled: "DISABLED" },
  },
  Content: {
    Simple: {
      Attachments: message.attachments?.map((attachment) => ({
        ContentDisposition: attachment.contentId === undefined ? "ATTACHMENT" : "INLINE",
        ContentId: attachment.contentId,
        ContentTransferEncoding: "BASE64",
        ContentType: attachment.contentType,
        FileName: attachment.filename,
        RawContent: attachment.contentBase64,
      })),
      Body: {
        Html:
          message.body.html === undefined
            ? undefined
            : { Charset: "utf-8", Data: message.body.html },
        Text:
          message.body.text === undefined
            ? undefined
            : { Charset: "utf-8", Data: message.body.text },
      },
      Headers: message.headers?.map(({ name, value }) => ({ Name: name, Value: value })),
      Subject: { Charset: "utf-8", Data: message.subject },
    },
  },
  Destination: {
    BccAddresses: message.bcc?.map(formatEmailMailbox),
    CcAddresses: message.cc?.map(formatEmailMailbox),
    ToAddresses: message.to.map(formatEmailMailbox),
  },
  EmailTags: message.tags?.map(({ name, value }) => ({ Name: name, Value: value })),
  FromEmailAddress: formatEmailMailbox(message.from),
  ReplyToAddresses: message.replyTo?.map(formatEmailMailbox),
});

const parseSesRejection = Effect.fnUntraced(function* parseSesRejection(
  response: HttpClientResponse.HttpClientResponse,
): Effect.fn.Return<never, EmailSubmissionError> {
  const { status } = response;

  if (status !== 400 && status !== 403 && status !== 429) {
    return yield* new EmailDeliveryUnknown({
      provider: "ses",
      reason: status >= 500 ? "server-error" : "unexpected-status",
      status,
    });
  }

  const invalid = () =>
    new EmailDeliveryUnknown({ provider: "ses", reason: "invalid-response", status });

  const problem = yield* readEmailHttpJson(response, "ses").pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(SesProblem, { onExcessProperty: "error" })),
    Effect.mapError(invalid),
  );

  const errorType = yield* Schema.decodeUnknownEffect(SesRefusalType)(
    response.headers["x-amzn-errortype"],
  ).pipe(Effect.mapError(invalid));

  if (problem.__type !== undefined && problem.__type !== errorType) {
    return yield* invalid();
  }

  if (status === 429 && errorType === "TooManyRequestsException") {
    return yield* Option.match(parseEmailHttpRetryAfterMillis(response.headers["retry-after"]), {
      onNone: () => new EmailRejected({ provider: "ses", reason: "rate-limited", status }),
      onSome: (retryAfterMillis) =>
        new EmailRejected({ provider: "ses", reason: "rate-limited", retryAfterMillis, status }),
    });
  }

  if (
    status === 403 &&
    (errorType === "AccessDeniedException" || errorType === "ExpiredTokenException")
  ) {
    return yield* new EmailRejected({ provider: "ses", reason: "authentication", status });
  }

  if (
    status === 400 &&
    (errorType === "MailFromDomainNotVerifiedException" ||
      errorType === "AccountSuspendedException" ||
      errorType === "SendingPausedException")
  ) {
    return yield* new EmailRejected({ provider: "ses", reason: "rejected", status });
  }

  return yield* invalid();
});

export const sesSenderLayer = (
  options: SesEmailOptions,
): Layer.Layer<EmailSender, EmailConfigurationError, HttpClient.HttpClient> =>
  emailHttpSenderLayer(SesConfiguration, options, (configuration) => {
    const validate = Effect.fnUntraced(function* validateSesIntent(
      message: EmailMessage,
    ): Effect.fn.Return<void, EmailInvalidMessage> {
      yield* validateEmailCapabilities(message, sesEmailCapabilities);
      const issues: string[] = [];
      const recipients = emailRecipientAddresses(message).map((address) => address.toLowerCase());

      if (new Set(recipients).size !== recipients.length) {
        issues.push("to");
      }

      if (!Schema.is(SesAsciiText)(message.subject)) {
        issues.push("subject");
      }

      if (
        [
          message.from,
          ...message.to,
          ...(message.cc ?? []),
          ...(message.bcc ?? []),
          ...(message.replyTo ?? []),
        ].some(
          (mailbox) =>
            !Schema.is(EmailAddressSchema)(mailbox) && !Schema.is(SesAsciiText)(mailbox.name ?? ""),
        )
      ) {
        issues.push("name");
      }

      if (
        (message.headers?.length ?? 0) > 15 ||
        message.headers?.some(
          ({ name, value }) =>
            !Schema.is(SesAsciiText)(value) ||
            name.length + value.length > 996 ||
            /^(?:x-ses-|x-amz-|x-amzn-|message-id$|feedback-id$|list-unsubscribe)/iu.test(name),
        ) === true
      ) {
        issues.push("headers");
      }

      if (
        message.tags?.some(
          ({ name, value }) => !Schema.is(SesTagText)(name) || !Schema.is(SesTagText)(value),
        ) === true
      ) {
        issues.push("tags");
      }

      if (
        message.attachments?.some(
          (attachment) =>
            attachment.contentType.length > 78 ||
            (attachment.contentId?.length ?? 0) > 78 ||
            !Schema.is(SesAttachmentExtension)(
              attachment.filename.split(".").at(-1)?.toLowerCase(),
            ),
        ) === true
      ) {
        issues.push("attachments");
      }

      if (
        new TextEncoder().encode(JSON.stringify(buildSesMessage(message))).byteLength > 8_000_000
      ) {
        issues.push("body");
      }

      if (issues.length > 0) {
        return yield* new EmailInvalidMessage({
          issues: [...new Set(issues)].map((path) => ({
            path,
            problem: "SES cannot preserve this constrained regional simple-message intent",
          })),
        });
      }

      return undefined;
    });

    const request = Effect.fnUntraced(function* buildSesRequest(
      submission: EmailSubmission,
    ): Effect.fn.Return<HttpClientRequest.HttpClientRequest, EmailRejected> {
      const body = JSON.stringify(buildSesMessage(submission.message));
      const timestamp = DateTime.formatIso(yield* DateTime.now).replaceAll(/[:-]|\.\d{3}/gu, "");
      const headers = signSesEmailRequest({ ...configuration, body, timestamp });

      return HttpClientRequest.post(
        `https://email.${configuration.region}.amazonaws.com/v2/email/outbound-emails`,
      ).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.bodyText(body, "application/json"),
        HttpClientRequest.setHeaders(headers),
      );
    });

    const respond = Effect.fnUntraced(function* parseSesAcknowledgement(
      response: HttpClientResponse.HttpClientResponse,
    ): Effect.fn.Return<EmailReceipt, EmailSubmissionError> {
      if (response.status !== 200) {
        return yield* parseSesRejection(response);
      }

      const acknowledgement = yield* readEmailHttpJson(response, "ses").pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(SesAcknowledgement, { onExcessProperty: "error" }),
        ),
        Effect.mapError(
          () =>
            new EmailDeliveryUnknown({
              provider: "ses",
              reason: "invalid-response",
              status: response.status,
            }),
        ),
      );

      return Object.freeze(
        EmailReceiptSchema.cases.Accepted.make({
          messageId: acknowledgement.MessageId,
          provider: "ses",
        }),
      );
    });

    return {
      capabilities: sesEmailCapabilities,
      idempotency: EmailSenderIdempotencySchema.cases.None.make({}),
      provider: "ses",
      request,
      respond,
      span: "Ses.submit",
      validate,
    };
  });

export const sesEmailLayer = (
  options: SesEmailOptions,
  policy?: EmailDeliveryPolicy,
  observer?: EmailRetryObserver,
  restriction?: EmailRetryRestriction,
): Layer.Layer<Email, EmailConfigurationError, HttpClient.HttpClient> =>
  emailLayer(policy, observer, restriction).pipe(Layer.provide(sesSenderLayer(options)));
