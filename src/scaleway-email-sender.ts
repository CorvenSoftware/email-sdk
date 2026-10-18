import { Effect, Layer, Redacted, Schema } from "effect";
import type { HttpClient, HttpClientResponse } from "effect/http";
import { HttpClientRequest } from "effect/http";
import { EmailAddressSchema, formatEmailMailbox } from "./email-address.js";
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
import { EmailMessageIdSchema, EmailRecipientOutcomeSchema } from "./email-message.js";
import type { EmailMessage, EmailReceipt } from "./email-message.js";
import { emailRecipientAddresses } from "./email-recipient-outcomes.js";
import { parseEmailRecipientReceipt } from "./email-recipient-receipt.js";
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

export const scalewayEmailCapabilities = ownEmailSenderCapabilities(
  EmailSenderCapabilitiesSchema.make({
    attachmentContentTypes: "Explicit",
    attachments: true,
    headers: "Unique",
    inlineAttachments: false,
    metadata: false,
    scheduling: false,
    tags: { asciiOnly: false, maxCount: 0 },
  }),
);

export interface ScalewayEmailOptions {
  readonly projectId: string;
  readonly secretKey: Redacted.Redacted;
  readonly tracking: "ProviderDisabled";
}

const ScalewayProjectId = Schema.String.check(Schema.isUUID());

const ScalewayMinimumContent = Schema.String.check(Schema.isPattern(/^.{10}/su));

const ScalewayConfiguration = Schema.Struct({
  projectId: ScalewayProjectId,
  secretKey: EmailHttpCredentialSchema,
  tracking: Schema.Literal("ProviderDisabled"),
});

const ScalewayAttachmentType = Schema.Literals([
  "application/acad-template",
  "application/acad",
  "application/autocad_dwg",
  "application/autocad_dxf",
  "application/dwf",
  "application/dxf",
  "application/ics",
  "application/msword",
  "application/pdf",
  "application/pkcs10",
  "application/pkcs7-mime",
  "application/pkcs7-signature",
  "application/vnd.dwt",
  "application/vnd.ms-excel",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/x-dwf",
  "application/x-dwg",
  "application/x-dwt",
  "application/x-dxf",
  "application/x-pkcs12",
  "application/x-pkcs7-certificates",
  "application/x-pkcs7-certreqresp",
  "application/x-pkcs7-crl",
  "application/x-pkcs7-mime",
  "application/x-pkcs7-signature",
  "application/xml",
  "audio/mpeg",
  "audio/wav",
  "image/gif",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/svg+xml",
  "image/tiff",
  "image/vnd.dwg",
  "image/vnd.dxf",
  "image/webp",
  "model/vnd.dwf",
  "text/calendar",
  "text/csv",
  "text/html",
  "text/plain",
  "text/xml",
]);

const ScalewayEmailRecord = Schema.Struct({
  id: EmailMessageIdSchema.check(Schema.isUUID()),
  mail_from: EmailAddressSchema,
  mail_rcpt: EmailAddressSchema,
  message_id: EmailMessageIdSchema.check(Schema.isUUID()),
  project_id: ScalewayProjectId,
  rcpt_to: Schema.optionalKey(EmailAddressSchema),
  rcpt_type: Schema.Literals(["to", "cc", "bcc"]),
  status: Schema.Literals(["new", "sending", "sent"]),
  subject: Schema.String,
});

const ScalewayAcknowledgement = Schema.Struct({
  emails: Schema.NonEmptyArray(ScalewayEmailRecord).check(Schema.isMaxLength(10)),
  error: Schema.optionalKey(Schema.Null),
  message: Schema.optionalKey(Schema.Null),
  type: Schema.optionalKey(Schema.Null),
});

const scalewayMailbox = (mailbox: EmailMailbox) =>
  Schema.is(EmailAddressSchema)(mailbox)
    ? { email: mailbox }
    : { email: mailbox.address, name: mailbox.name };

const buildScalewayMessage = (message: EmailMessage, projectId: string) => {
  const headers = (message.headers ?? []).map(({ name, value }) => ({ key: name, value }));

  if (message.replyTo !== undefined) {
    headers.push({ key: "Reply-To", value: message.replyTo.map(formatEmailMailbox).join(", ") });
  }

  return {
    additional_headers: headers.length > 0 ? headers : undefined,
    attachments: message.attachments?.map((attachment) => ({
      content: attachment.contentBase64,
      name: attachment.filename,
      type: attachment.contentType,
    })),
    bcc: message.bcc?.map(scalewayMailbox),
    cc: message.cc?.map(scalewayMailbox),
    from: scalewayMailbox(message.from),
    html: message.body.html,
    project_id: projectId,
    subject: message.subject,
    text: message.body.text,
    to: message.to.map(scalewayMailbox),
  };
};

export const scalewaySenderLayer = (
  options: ScalewayEmailOptions,
): Layer.Layer<EmailSender, EmailConfigurationError, HttpClient.HttpClient> =>
  emailHttpSenderLayer(ScalewayConfiguration, options, (configuration) => {
    const validate = Effect.fnUntraced(function* validateScalewayIntent(
      message: EmailMessage,
    ): Effect.fn.Return<void, EmailInvalidMessage> {
      yield* validateEmailCapabilities(message, scalewayEmailCapabilities);
      const issues: string[] = [];
      const recipients = emailRecipientAddresses(message).map((address) => address.toLowerCase());

      if (recipients.length > 10 || new Set(recipients).size !== recipients.length) {
        issues.push("to");
      }

      if (!Schema.is(ScalewayMinimumContent)(message.subject)) {
        issues.push("subject");
      }

      if (
        [message.body.html, message.body.text].some(
          (body) => body !== undefined && !Schema.is(ScalewayMinimumContent)(body),
        )
      ) {
        issues.push("body");
      }

      if (
        message.attachments?.some(
          (attachment) => !Schema.is(ScalewayAttachmentType)(attachment.contentType),
        ) === true
      ) {
        issues.push("attachments");
      }

      if (
        message.headers?.some(({ name }) => {
          const lower = name.toLowerCase();

          return (
            [
              "x-auth-token",
              "x-send-before",
              "send-before",
              "received-spf",
              "delivered-to",
              "authentication-results",
            ].includes(lower) ||
            lower.startsWith("x-scw-") ||
            lower.startsWith("resent-")
          );
        }) === true
      ) {
        issues.push("headers");
      }

      if (
        message.replyTo !== undefined &&
        message.replyTo.map(formatEmailMailbox).join(", ").length > 998
      ) {
        issues.push("replyTo");
      }

      if (
        new TextEncoder().encode(
          JSON.stringify(buildScalewayMessage(message, configuration.projectId)),
        ).byteLength > 1_900_000
      ) {
        issues.push("body");
      }

      if (issues.length > 0) {
        return yield* new EmailInvalidMessage({
          issues: [...new Set(issues)].map((path) => ({
            path,
            problem: "Scaleway cannot preserve this constrained transactional intent",
          })),
        });
      }

      return undefined;
    });

    const request = Effect.fnUntraced(function* buildScalewayRequest(
      submission: EmailSubmission,
    ): Effect.fn.Return<HttpClientRequest.HttpClientRequest, EmailRejected> {
      return yield* HttpClientRequest.post(
        "https://api.scaleway.com/transactional-email/v1alpha1/regions/fr-par/emails",
      ).pipe(
        HttpClientRequest.setHeader("X-Auth-Token", Redacted.value(configuration.secretKey)),
        HttpClientRequest.acceptJson,
        HttpClientRequest.bodyJson(
          buildScalewayMessage(submission.message, configuration.projectId),
        ),
        Effect.mapError(
          () => new EmailRejected({ provider: "scaleway", reason: "invalid-message" }),
        ),
      );
    });

    const respond = Effect.fnUntraced(function* parseScalewayAcknowledgement(
      response: HttpClientResponse.HttpClientResponse,
      message: EmailMessage,
    ): Effect.fn.Return<EmailReceipt, EmailSubmissionError> {
      const { status } = response;

      const invalid = () =>
        new EmailDeliveryUnknown({ provider: "scaleway", reason: "invalid-response", status });

      if (status !== 200) {
        return yield* new EmailDeliveryUnknown({
          provider: "scaleway",
          reason: status >= 500 ? "server-error" : "unexpected-status",
          status,
        });
      }

      const body = yield* readEmailHttpJson(response, "scaleway").pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(ScalewayAcknowledgement)),
        Effect.mapError(invalid),
      );

      const from = scalewayMailbox(message.from).email;

      const expected = [
        ...message.to.map((mailbox) => ({ email: scalewayMailbox(mailbox).email, role: "to" })),
        ...(message.cc ?? []).map((mailbox) => ({
          email: scalewayMailbox(mailbox).email,
          role: "cc",
        })),
        ...(message.bcc ?? []).map((mailbox) => ({
          email: scalewayMailbox(mailbox).email,
          role: "bcc",
        })),
      ];

      if (
        body.emails.some(
          (record) =>
            record.project_id.toLowerCase() !== configuration.projectId.toLowerCase() ||
            record.mail_from.toLowerCase() !== from.toLowerCase() ||
            record.subject !== message.subject ||
            (record.rcpt_to !== undefined &&
              record.rcpt_to.toLowerCase() !== record.mail_rcpt.toLowerCase()) ||
            !expected.some(
              (recipient) =>
                recipient.email.toLowerCase() === record.mail_rcpt.toLowerCase() &&
                recipient.role === record.rcpt_type,
            ),
        ) ||
        new Set(body.emails.map((record) => record.message_id.toLowerCase())).size !== 1 ||
        new Set(body.emails.map((record) => record.id.toLowerCase())).size !== body.emails.length
      ) {
        return yield* invalid();
      }

      return yield* parseEmailRecipientReceipt(
        message,
        body.emails.map((record) =>
          EmailRecipientOutcomeSchema.cases.Accepted.make({
            messageId: record.id,
            recipient: record.mail_rcpt,
          }),
        ),
        "scaleway",
        status,
        body.emails[0].message_id,
      );
    });

    return {
      capabilities: scalewayEmailCapabilities,
      idempotency: EmailSenderIdempotencySchema.cases.None.make({}),
      provider: "scaleway",
      request,
      respond,
      span: "Scaleway.submit",
      validate,
    };
  });

export const scalewayEmailLayer = (
  options: ScalewayEmailOptions,
  policy?: EmailDeliveryPolicy,
  observer?: EmailRetryObserver,
  restriction?: EmailRetryRestriction,
): Layer.Layer<Email, EmailConfigurationError, HttpClient.HttpClient> =>
  emailLayer(policy, observer, restriction).pipe(Layer.provide(scalewaySenderLayer(options)));
