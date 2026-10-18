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
import { EmailDeliveryUnknown } from "./email-delivery-unknown.js";
import type { EmailSubmissionError } from "./email-errors.js";
import { emailHttpSenderLayer } from "./email-http-protocol.js";
import { EmailHttpCredentialSchema } from "./email-http-credential.js";
import { readEmailHttpJson } from "./email-http-response.js";
import { parseEmailHttpRetryAfterMillis } from "./email-http-retry-after.js";
import { formatEmailTagLabel } from "./email-message-metadata.js";
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

export const mailpaceEmailCapabilities = ownEmailSenderCapabilities(
  EmailSenderCapabilitiesSchema.make({
    attachmentContentTypes: "Explicit",
    attachments: true,
    headers: "Unique",
    inlineAttachments: true,
    metadata: false,
    scheduling: false,
    tags: { asciiOnly: false, maxCount: 75 },
  }),
);

export interface MailpaceEmailOptions {
  readonly serverToken: Redacted.Redacted;
}

const MailpaceConfiguration = Schema.Struct({
  serverToken: EmailHttpCredentialSchema,
});

const MailpaceAcknowledgement = Schema.Struct({
  id: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  status: Schema.Literal("pending"),
});

const MailpaceAuthenticationRejection = Schema.Struct({
  error: Schema.Literal("Invalid API Token"),
});

const MailpaceAttachmentExtension = Schema.Literals([
  "jpeg",
  "jpg",
  "png",
  "gif",
  "txt",
  "pdf",
  "docx",
  "xlsx",
  "pptx",
  "csv",
  "att",
  "ics",
  "ical",
  "html",
  "zip",
  "auf",
  "xml",
  "dwg",
]);

const MailpaceHeaderName = Schema.Literals(["in-reply-to", "references", "list-unsubscribe"]);

const classifyMailpaceRejection = Effect.fnUntraced(function* classifyMailpaceRejection(
  response: HttpClientResponse.HttpClientResponse,
): Effect.fn.Return<never, EmailSubmissionError> {
  const { status } = response;

  if (status >= 500) {
    return yield* new EmailDeliveryUnknown({
      provider: "mailpace",
      reason: "server-error",
      status,
    });
  }

  const reason = Match.value(status).pipe(
    Match.when(400, () => "invalid-message" as const),
    Match.when(
      (code) => code === 401 || code === 403,
      () => "authentication" as const,
    ),
    Match.when(
      (code) => code === 406 || code === 413,
      () => "invalid-message" as const,
    ),
    Match.when(429, () => "rate-limited" as const),
    Match.orElse(() => "unexpected-status" as const),
  );

  if (reason === "unexpected-status") {
    return yield* new EmailDeliveryUnknown({ provider: "mailpace", reason, status });
  }

  if (status === 400) {
    const invalidToken = yield* readEmailHttpJson(response, "mailpace").pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(MailpaceAuthenticationRejection)),
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );

    if (invalidToken) {
      return yield* new EmailRejected({ provider: "mailpace", reason: "authentication", status });
    }
  }

  return yield* Option.match(parseEmailHttpRetryAfterMillis(response.headers["retry-after"]), {
    onNone: () => new EmailRejected({ provider: "mailpace", reason, status }),
    onSome: (retryAfterMillis) =>
      new EmailRejected({ provider: "mailpace", reason, retryAfterMillis, status }),
  });
});

const validateMailpaceIntent = Effect.fnUntraced(function* validateMailpaceIntent(
  message: EmailSubmission["message"],
): Effect.fn.Return<void, EmailInvalidMessage> {
  yield* validateEmailCapabilities(message, mailpaceEmailCapabilities);
  const issues: { path: string; problem: string }[] = [];

  if (
    message.replyTo !== undefined &&
    (message.replyTo.length !== 1 || !message.replyTo.every(Schema.is(EmailAddressSchema)))
  ) {
    issues.push({ path: "replyTo", problem: "MailPace supports one plain reply-to address" });
  }

  if (
    message.headers?.some(({ name }) => !Schema.is(MailpaceHeaderName)(name.toLowerCase())) === true
  ) {
    issues.push({
      path: "headers",
      problem: "MailPace supports only In-Reply-To, References, and List-Unsubscribe",
    });
  }

  if (message.tags?.some(({ name }) => name.includes(":")) === true) {
    issues.push({ path: "tags", problem: "MailPace name:value tags require colon-free names" });
  }

  for (const [index, attachment] of (message.attachments ?? []).entries()) {
    const [, extension, extra] = attachment.filename.split(".");

    if (
      extra !== undefined ||
      extension === undefined ||
      !Schema.is(MailpaceAttachmentExtension)(extension.toLowerCase())
    ) {
      issues.push({
        path: `attachments[${index}].filename`,
        problem: "MailPace requires one period and a supported attachment extension",
      });
    }
  }

  if (issues.length > 0) {
    return yield* new EmailInvalidMessage({ issues });
  }

  return undefined;
});

const mailpacePreflight = {
  capabilities: mailpaceEmailCapabilities,
  idempotency: EmailSenderIdempotencySchema.cases.None.make({}),
  provider: "mailpace",
  validate: validateMailpaceIntent,
};

export const preflightMailpaceEmail = (
  message: EmailMessageInput,
  options?: EmailSendOptionsInput,
) => preflightEmailMessage(mailpacePreflight, message, options);

export const mailpaceSenderLayer = (
  options: MailpaceEmailOptions,
): Layer.Layer<EmailSender, EmailConfigurationError, HttpClient.HttpClient> =>
  emailHttpSenderLayer(MailpaceConfiguration, options, (configuration) => {
    const request = Effect.fnUntraced(function* buildMailpaceRequest(
      submission: EmailSubmission,
    ): Effect.fn.Return<HttpClientRequest.HttpClientRequest, EmailRejected> {
      const { message } = submission;

      const headers = new Map(
        message.headers?.map(({ name, value }) => [name.toLowerCase(), value]),
      );

      return yield* HttpClientRequest.post("https://app.mailpace.com/api/v1/send").pipe(
        HttpClientRequest.setHeader(
          "MailPace-Server-Token",
          Redacted.value(configuration.serverToken),
        ),
        HttpClientRequest.acceptJson,
        HttpClientRequest.bodyJson({
          attachments: message.attachments?.map((attachment) => ({
            cid: attachment.contentId === undefined ? undefined : `<${attachment.contentId}>`,
            content: attachment.contentBase64,
            content_type: emailAttachmentMimeType(attachment),
            name: attachment.filename,
          })),
          bcc: message.bcc?.map(formatEmailMailbox).join(","),
          cc: message.cc?.map(formatEmailMailbox).join(","),
          from: formatEmailMailbox(message.from),
          htmlbody: message.body.html,
          inreplyto: headers.get("in-reply-to"),
          list_unsubscribe: headers.get("list-unsubscribe"),
          references: headers.get("references"),
          replyto: message.replyTo?.map(formatEmailMailbox).join(","),
          subject: message.subject,
          tags: message.tags?.map(formatEmailTagLabel),
          textbody: message.body.text,
          to: message.to.map(formatEmailMailbox).join(","),
        }),
        Effect.mapError(
          () => new EmailRejected({ provider: "mailpace", reason: "invalid-message" }),
        ),
      );
    });

    const respond = Effect.fnUntraced(function* readMailpaceAcknowledgement(
      response: HttpClientResponse.HttpClientResponse,
    ): Effect.fn.Return<EmailReceipt, EmailSubmissionError> {
      if (response.status !== 200) {
        return yield* classifyMailpaceRejection(response);
      }

      const acknowledgement = yield* readEmailHttpJson(response, "mailpace").pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(MailpaceAcknowledgement)),
        Effect.mapError(
          () =>
            new EmailDeliveryUnknown({
              provider: "mailpace",
              reason: "invalid-response",
              status: response.status,
            }),
        ),
      );

      const messageId = yield* Schema.decodeEffect(EmailMessageIdSchema)(
        String(acknowledgement.id),
      ).pipe(
        Effect.mapError(
          () =>
            new EmailDeliveryUnknown({
              provider: "mailpace",
              reason: "invalid-response",
              status: response.status,
            }),
        ),
      );

      return EmailReceiptSchema.cases.Accepted.make({ messageId, provider: "mailpace" });
    });

    return {
      ...mailpacePreflight,
      request,
      respond,
      span: "MailPace.submit",
    };
  });

export const mailpaceEmailLayer = (
  options: MailpaceEmailOptions,
  policy?: EmailDeliveryPolicy,
  observer?: EmailRetryObserver,
  restriction?: EmailRetryRestriction,
): Layer.Layer<Email, EmailConfigurationError, HttpClient.HttpClient> =>
  emailLayer(policy, observer, restriction).pipe(Layer.provide(mailpaceSenderLayer(options)));
