import { DateTime, Effect, Layer, Match, Redacted, Schema } from "effect";
import { HttpClientRequest } from "effect/http";
import type { HttpClient, HttpClientResponse } from "effect/http";
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
import { EmailHttpCredentialSchema } from "./email-http-credential.js";
import { emailHttpSenderLayer } from "./email-http-protocol.js";
import { readEmailHttpJson } from "./email-http-response.js";
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

export const brevoEmailCapabilities = ownEmailSenderCapabilities(
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

const BrevoConfiguration = Schema.Struct({
  apiKey: EmailHttpCredentialSchema,
  contentAuthority: Schema.Literal("AuthorizeProviderRendering"),
  submissionMode: Schema.Literal("TransactionalOnly"),
  tracking: Schema.Literal("AuthorizeProviderTracking"),
});

export type BrevoEmailOptions = typeof BrevoConfiguration.Type;

const BrevoAcknowledgement = Schema.Struct({
  code: Schema.optionalKey(Schema.Never),
  messageId: EmailMessageIdSchema,
  messageIds: Schema.optionalKey(Schema.Never),
});

const BrevoProblem = Schema.Struct({ code: Schema.String.check(Schema.isMaxLength(128)) });

const attachmentExtensions = new Set([
  "xlsx",
  "xls",
  "ods",
  "docx",
  "docm",
  "doc",
  "csv",
  "pdf",
  "txt",
  "gif",
  "jpg",
  "jpeg",
  "png",
  "tif",
  "tiff",
  "rtf",
  "bmp",
  "cgm",
  "css",
  "shtml",
  "html",
  "htm",
  "zip",
  "xml",
  "ppt",
  "pptx",
  "tar",
  "ez",
  "ics",
  "mobi",
  "msg",
  "pub",
  "eps",
  "odt",
  "mp3",
  "m4a",
  "m4v",
  "wma",
  "ogg",
  "flac",
  "wav",
  "aif",
  "aifc",
  "aiff",
  "mp4",
  "mov",
  "avi",
  "mkv",
  "mpeg",
  "mpg",
  "wmv",
  "pkpass",
  "xlsm",
]);

const formatBrevoMailbox = (mailbox: EmailMailbox) =>
  Schema.is(EmailAddressSchema)(mailbox)
    ? { email: mailbox }
    : { email: mailbox.address, name: mailbox.name };

const validateBrevoIntent = Effect.fnUntraced(function* validateBrevoIntent(
  message: EmailMessage,
): Effect.fn.Return<void, EmailInvalidMessage> {
  yield* validateEmailCapabilities(message, brevoEmailCapabilities);
  const issues = [];

  if (message.body.html === undefined || message.body.text !== undefined) {
    issues.push({
      path: "body",
      problem:
        "Brevo's constrained inline contract requires HTML without a selected text alternative",
    });
  }

  if (
    [
      message.from,
      ...message.to,
      ...(message.cc ?? []),
      ...(message.bcc ?? []),
      ...(message.replyTo ?? []),
    ].some((mailbox) => !Schema.is(EmailAddressSchema)(mailbox) && (mailbox.name?.length ?? 0) > 70)
  ) {
    issues.push({ path: "name", problem: "Brevo display names must fit within 70 characters" });
  }

  if ((message.replyTo?.length ?? 0) > 1) {
    issues.push({ path: "replyTo", problem: "Brevo accepts one reply identity" });
  }

  if (
    message.attachments?.some(
      ({ filename }) =>
        filename.length > 70 ||
        !attachmentExtensions.has(filename.split(".").at(-1)?.toLowerCase() ?? ""),
    ) === true
  ) {
    issues.push({
      path: "attachments.filename",
      problem:
        "Brevo attachments require a documented extension and at most 70 filename characters",
    });
  }

  if (
    message.headers?.some(
      ({ name }) =>
        !/^X-(?:[A-Z][a-z0-9]*)(?:-[A-Z][a-z0-9]*)*$/u.test(name) ||
        /^(?:X-Mailin-|X-Sib-|X-Brevo-)/u.test(name),
    ) === true
  ) {
    issues.push({
      path: "headers",
      problem:
        "Brevo custom headers must retain documented title casing and avoid provider controls",
    });
  }

  if (issues.length > 0) {
    return yield* new EmailInvalidMessage({ issues });
  }

  return undefined;
});

const readBrevoAcknowledgement = Effect.fnUntraced(function* readBrevoAcknowledgement(
  response: HttpClientResponse.HttpClientResponse,
  message: EmailMessage,
): Effect.fn.Return<EmailReceipt, EmailSubmissionError> {
  if (message.sendAt !== undefined && response.status === 202) {
    return Object.freeze(EmailReceiptSchema.cases.Accepted.make({ provider: "brevo" }));
  }

  if (message.sendAt === undefined && response.status === 201) {
    const body = yield* readEmailHttpJson(response, "brevo");

    const acknowledgement = yield* Schema.decodeUnknownEffect(BrevoAcknowledgement)(body).pipe(
      Effect.mapError(
        () =>
          new EmailDeliveryUnknown({
            provider: "brevo",
            reason: "invalid-response",
            status: response.status,
          }),
      ),
    );

    return Object.freeze(
      EmailReceiptSchema.cases.Accepted.make({
        messageId: acknowledgement.messageId,
        provider: "brevo",
      }),
    );
  }

  if (response.status === 400 || response.status === 401 || response.status === 403) {
    const problem = yield* readEmailHttpJson(response, "brevo");

    const decoded = yield* Schema.decodeUnknownEffect(BrevoProblem)(problem).pipe(
      Effect.mapError(
        () =>
          new EmailDeliveryUnknown({
            provider: "brevo",
            reason: "invalid-response",
            status: response.status,
          }),
      ),
    );

    const reason = Match.value(decoded.code).pipe(
      Match.when("unauthorized", () => "authentication" as const),
      Match.when(
        (code) =>
          [
            "invalid_parameter",
            "missing_parameter",
            "out_of_range",
            "bad_request",
            "unprocessable_entity",
          ].includes(code),
        () => "invalid-message" as const,
      ),
      Match.when(
        (code) =>
          ["not_enough_credits", "permission_denied", "account_under_validation"].includes(code),
        () => "rejected" as const,
      ),
      Match.orElse(() => "invalid-response" as const),
    );

    if (reason !== "invalid-response") {
      return yield* new EmailRejected({ provider: "brevo", reason, status: response.status });
    }
  }

  return yield* new EmailDeliveryUnknown({
    provider: "brevo",
    reason: response.status >= 500 ? "server-error" : "unexpected-status",
    status: response.status,
  });
});

export const brevoSenderLayer = (
  options: BrevoEmailOptions,
): Layer.Layer<EmailSender, EmailConfigurationError, HttpClient.HttpClient> =>
  emailHttpSenderLayer(BrevoConfiguration, options, (configuration) => ({
    capabilities: brevoEmailCapabilities,
    idempotency: EmailSenderIdempotencySchema.cases.None.make({}),
    provider: "brevo",
    request: Effect.fnUntraced(function* buildBrevoRequest(
      submission: EmailSubmission,
    ): Effect.fn.Return<HttpClientRequest.HttpClientRequest, EmailRejected> {
      const { message } = submission;

      return yield* HttpClientRequest.post("https://api.brevo.com/v3/smtp/email").pipe(
        HttpClientRequest.setHeader("api-key", Redacted.value(configuration.apiKey)),
        HttpClientRequest.acceptJson,
        HttpClientRequest.bodyJson({
          attachment: message.attachments?.map((attachment) => ({
            content: attachment.contentBase64,
            name: attachment.filename,
          })),
          bcc: message.bcc?.map(formatBrevoMailbox),
          cc: message.cc?.map(formatBrevoMailbox),
          headers:
            message.headers === undefined
              ? undefined
              : Object.fromEntries(message.headers.map(({ name, value }) => [name, value])),
          htmlContent: message.body.html,
          replyTo: message.replyTo?.map(formatBrevoMailbox)[0],
          scheduledAt:
            message.sendAt === undefined ? undefined : DateTime.formatIso(message.sendAt),
          sender: formatBrevoMailbox(message.from),
          subject: message.subject,
          to: message.to.map(formatBrevoMailbox),
        }),
        Effect.mapError(() => new EmailRejected({ provider: "brevo", reason: "invalid-message" })),
      );
    }),
    respond: readBrevoAcknowledgement,
    span: "Brevo.submit",
    validate: validateBrevoIntent,
  }));

export const brevoEmailLayer = (
  options: BrevoEmailOptions,
  policy?: EmailDeliveryPolicy,
  observer?: EmailRetryObserver,
  restriction?: EmailRetryRestriction,
): Layer.Layer<Email, EmailConfigurationError, HttpClient.HttpClient> =>
  emailLayer(policy, observer, restriction).pipe(Layer.provide(brevoSenderLayer(options)));
