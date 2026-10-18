import { Effect, Layer, Redacted, Schema } from "effect";
import type { HttpClient, HttpClientResponse } from "effect/http";
import { HttpClientRequest } from "effect/http";
import { EmailAddressSchema } from "./email-address.js";
import type { EmailMailbox } from "./email-address.js";
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
import { formatEmailTagLabel } from "./email-message-metadata.js";
import { EmailInvalidMessage } from "./email-invalid-message.js";
import { EmailMessageIdsSchema, EmailReceiptSchema } from "./email-message.js";
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

export const mailtrapEmailCapabilities = ownEmailSenderCapabilities(
  EmailSenderCapabilitiesSchema.make({
    attachmentContentTypes: "Both",
    attachments: true,
    headers: "Unique",
    inlineAttachments: true,
    metadata: true,
    scheduling: false,
    tags: { asciiOnly: false, maxCount: 1 },
  }),
);

export interface MailtrapEmailOptions {
  readonly apiKey: Redacted.Redacted;
  readonly automaticBcc: "DomainDisabled";
  readonly automaticFooter: "DomainDisabled";
  readonly tracking: "DomainDisabled";
}

const MailtrapConfiguration = Schema.Struct({
  apiKey: EmailHttpCredentialSchema,
  automaticBcc: Schema.Literal("DomainDisabled"),
  automaticFooter: Schema.Literal("DomainDisabled"),
  tracking: Schema.Literal("DomainDisabled"),
});

const MailtrapAcknowledgement = Schema.Struct({
  error: Schema.optionalKey(Schema.Null),
  errors: Schema.optionalKey(Schema.Array(Schema.String).check(Schema.isMaxLength(0))),
  message_ids: EmailMessageIdsSchema,
  success: Schema.Literal(true),
});

const MailtrapProblem = Schema.Struct({
  error: Schema.optionalKey(Schema.Null),
  errors: Schema.NonEmptyArray(Schema.String.check(Schema.isMaxLength(4096))).check(
    Schema.isMaxLength(50),
  ),
  message_ids: Schema.optionalKey(Schema.Array(Schema.String).check(Schema.isMaxLength(0))),
  success: Schema.Literal(false),
});

const mailtrapMailbox = (mailbox: EmailMailbox) =>
  Schema.is(EmailAddressSchema)(mailbox)
    ? { email: mailbox }
    : { email: mailbox.address, name: mailbox.name };

const classifyMailtrapRejection = Effect.fnUntraced(function* classifyMailtrapRejection(
  response: HttpClientResponse.HttpClientResponse,
): Effect.fn.Return<never, EmailSubmissionError> {
  const { status } = response;

  if (![401, 403].includes(status)) {
    return yield* new EmailDeliveryUnknown({
      provider: "mailtrap",
      reason: status >= 500 ? "server-error" : "unexpected-status",
      status,
    });
  }

  yield* readEmailHttpJson(response, "mailtrap").pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(MailtrapProblem)),
    Effect.mapError(
      () => new EmailDeliveryUnknown({ provider: "mailtrap", reason: "invalid-response", status }),
    ),
  );

  const reason = status === 401 ? "authentication" : "rejected";

  return yield* new EmailRejected({ provider: "mailtrap", reason, status });
});

export const mailtrapSenderLayer = (
  options: MailtrapEmailOptions,
): Layer.Layer<EmailSender, EmailConfigurationError, HttpClient.HttpClient> =>
  emailHttpSenderLayer(MailtrapConfiguration, options, (configuration) => {
    const validate = Effect.fnUntraced(function* validateMailtrapIntent(
      message: EmailMessage,
    ): Effect.fn.Return<void, EmailInvalidMessage> {
      yield* validateEmailCapabilities(message, mailtrapEmailCapabilities);

      const issues: string[] = [];
      const addresses = emailRecipientAddresses(message).map((address) => address.toLowerCase());

      if (new Set(addresses).size !== addresses.length) {
        issues.push("to");
      }

      if (
        [message.body.html, message.body.text].some(
          (body) => body?.includes("__unsubscribe_url__") === true,
        )
      ) {
        issues.push("body");
      }

      if (message.replyTo !== undefined && message.replyTo.length !== 1) {
        issues.push("replyTo");
      }

      if (
        message.tags?.some(
          ({ name, value }) => name.includes(":") || name.length + value.length + 1 > 255,
        ) === true
      ) {
        issues.push("tags");
      }

      if (
        message.metadata !== undefined &&
        new TextEncoder().encode(JSON.stringify(message.metadata)).byteLength > 1000
      ) {
        issues.push("metadata");
      }

      if (
        message.headers?.some(
          ({ name }) =>
            ["user-agent", "api-token", "list-unsubscribe", "list-unsubscribe-post"].includes(
              name.toLowerCase(),
            ) || name.toLowerCase().startsWith("x-mt-"),
        ) === true
      ) {
        issues.push("headers");
      }

      if (issues.length > 0) {
        return yield* new EmailInvalidMessage({
          issues: issues.map((path) => ({
            path,
            problem: "Mailtrap cannot preserve this transactional intent",
          })),
        });
      }

      return undefined;
    });

    const request = Effect.fnUntraced(function* buildMailtrapRequest(
      submission: EmailSubmission,
    ): Effect.fn.Return<HttpClientRequest.HttpClientRequest, EmailRejected> {
      const { message } = submission;
      const [replyTo] = message.replyTo ?? [];
      const [tag] = message.tags ?? [];

      return yield* HttpClientRequest.post("https://send.api.mailtrap.io/api/send").pipe(
        HttpClientRequest.setHeader("Api-Token", Redacted.value(configuration.apiKey)),
        HttpClientRequest.setHeader("User-Agent", "corven-email-sdk"),
        HttpClientRequest.acceptJson,
        HttpClientRequest.bodyJson({
          attachments: message.attachments?.map((attachment) => ({
            content: attachment.contentBase64,
            content_id: attachment.contentId,
            disposition: attachment.contentId === undefined ? "attachment" : "inline",
            filename: attachment.filename,
            type: emailAttachmentMimeType(attachment),
          })),
          bcc: message.bcc?.map(mailtrapMailbox),
          category: tag === undefined ? undefined : formatEmailTagLabel(tag),
          cc: message.cc?.map(mailtrapMailbox),
          custom_variables: message.metadata,
          from: mailtrapMailbox(message.from),
          headers:
            message.headers === undefined
              ? undefined
              : Object.fromEntries(message.headers.map(({ name, value }) => [name, value])),
          html: message.body.html,
          reply_to: replyTo === undefined ? undefined : mailtrapMailbox(replyTo),
          subject: message.subject,
          text: message.body.text,
          to: message.to.map(mailtrapMailbox),
        }),
        Effect.mapError(
          () => new EmailRejected({ provider: "mailtrap", reason: "invalid-message" }),
        ),
      );
    });

    const respond = Effect.fnUntraced(function* parseMailtrapAcknowledgement(
      response: HttpClientResponse.HttpClientResponse,
      message: EmailMessage,
    ): Effect.fn.Return<EmailReceipt, EmailSubmissionError> {
      if (response.status !== 200) {
        return yield* classifyMailtrapRejection(response);
      }

      const acknowledgement = yield* readEmailHttpJson(response, "mailtrap").pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(MailtrapAcknowledgement)),
        Effect.mapError(
          () =>
            new EmailDeliveryUnknown({
              provider: "mailtrap",
              reason: "invalid-response",
              status: response.status,
            }),
        ),
      );

      if (acknowledgement.message_ids.length !== emailRecipientAddresses(message).length) {
        return yield* new EmailDeliveryUnknown({
          provider: "mailtrap",
          reason: "invalid-response",
          status: response.status,
        });
      }

      const receipt = EmailReceiptSchema.cases.AcceptedWithIds.make({
        messageIds: acknowledgement.message_ids,
        provider: "mailtrap",
      });

      Object.freeze(receipt.messageIds);

      return Object.freeze(receipt);
    });

    return {
      capabilities: mailtrapEmailCapabilities,
      idempotency: EmailSenderIdempotencySchema.cases.None.make({}),
      provider: "mailtrap",
      request,
      respond,
      span: "Mailtrap.submit",
      validate,
    };
  });

export const mailtrapEmailLayer = (
  options: MailtrapEmailOptions,
  policy?: EmailDeliveryPolicy,
  observer?: EmailRetryObserver,
  restriction?: EmailRetryRestriction,
): Layer.Layer<Email, EmailConfigurationError, HttpClient.HttpClient> =>
  emailLayer(policy, observer, restriction).pipe(Layer.provide(mailtrapSenderLayer(options)));
