import { Effect, Layer, Redacted, Schema } from "effect";
import type { HttpClient, HttpClientResponse } from "effect/http";
import { HttpClientRequest } from "effect/http";
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

export const zeptomailEmailCapabilities = ownEmailSenderCapabilities(
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

export interface ZeptomailEmailOptions {
  readonly agentMode: "Live" | "Sandbox";
  readonly apiKey: Redacted.Redacted;
}

const ZeptomailConfiguration = Schema.Struct({
  agentMode: Schema.Literals(["Live", "Sandbox"]),
  apiKey: EmailHttpCredentialSchema,
});

const ZeptomailAcknowledgement = Schema.Struct({
  data: Schema.Tuple([
    Schema.Struct({
      additional_info: Schema.Array(Schema.Never),
      code: Schema.Literal("EM_104"),
      error: Schema.optionalKey(Schema.Null),
    }),
  ]),
  error: Schema.optionalKey(Schema.Null),
  message: Schema.Literal("OK"),
  object: Schema.optionalKey(Schema.Literal("email")),
  request_id: EmailMessageIdSchema,
});

const ZeptomailUnsupportedExtension = Schema.Literals([
  "ade",
  "adp",
  "bat",
  "chm",
  "cmd",
  "com",
  "cpl",
  "exe",
  "hta",
  "ins",
  "isp",
  "js",
  "jse",
  "lib",
  "lnk",
  "mde",
  "msc",
  "msp",
  "mst",
  "pif",
  "scr",
  "sct",
  "shb",
  "sys",
  "vb",
  "vbe",
  "vbs",
  "vxd",
  "wsc",
  "wsf",
  "wsh",
  "app",
  "asp",
  "bas",
  "cer",
  "cnt",
  "crt",
  "csh",
  "der",
  "fxp",
  "gadget",
  "hlp",
  "hpj",
  "inf",
  "ksh",
  "mad",
  "maf",
  "mag",
  "mam",
  "maq",
  "mar",
  "mas",
  "mat",
  "mau",
  "mav",
  "maw",
  "mda",
  "mdb",
  "mdt",
  "mdw",
  "mdz",
  "msh",
  "msh1",
  "msh2",
  "msh1xml",
  "msh2xml",
  "msi",
  "ops",
  "osd",
  "pcd",
  "plg",
  "prf",
  "prg",
  "pst",
  "reg",
  "scf",
  "shs",
  "ps1",
  "ps1xml",
  "ps2",
  "ps2xml",
  "psc1",
  "psc2",
  "tmp",
  "url",
  "vbp",
  "vsmacros",
  "vsw",
  "ws",
  "xnk",
]);

const zeptomailMailbox = (mailbox: EmailMailbox) =>
  Schema.is(EmailAddressSchema)(mailbox) ? { address: mailbox } : mailbox;

const buildZeptomailMessage = (message: EmailMessage) => ({
  attachments: message.attachments
    ?.filter((attachment) => attachment.contentId === undefined)
    .map((attachment) => ({
      content: attachment.contentBase64,
      mime_type: attachment.contentType,
      name: attachment.filename,
    })),
  bcc: message.bcc?.map((mailbox) => ({ email_address: zeptomailMailbox(mailbox) })),
  cc: message.cc?.map((mailbox) => ({ email_address: zeptomailMailbox(mailbox) })),
  from: zeptomailMailbox(message.from),
  htmlbody: message.body.html,
  inline_images: message.attachments
    ?.filter((attachment) => attachment.contentId !== undefined)
    .map((attachment) => ({
      cid: attachment.contentId,
      content: attachment.contentBase64,
      mime_type: attachment.contentType,
      name: attachment.filename,
    })),
  mime_headers:
    message.headers === undefined
      ? undefined
      : Object.fromEntries(message.headers.map(({ name, value }) => [name, value])),
  reply_to: message.replyTo?.map(zeptomailMailbox),
  subject: message.subject,
  textbody: message.body.text,
  to: message.to.map((mailbox) => ({ email_address: zeptomailMailbox(mailbox) })),
  track_clicks: false,
  track_opens: false,
});

export const zeptomailSenderLayer = (
  options: ZeptomailEmailOptions,
): Layer.Layer<EmailSender, EmailConfigurationError, HttpClient.HttpClient> =>
  emailHttpSenderLayer(ZeptomailConfiguration, options, (configuration) => {
    const validate = Effect.fnUntraced(function* validateZeptomailIntent(
      message: EmailMessage,
    ): Effect.fn.Return<void, EmailInvalidMessage> {
      yield* validateEmailCapabilities(message, zeptomailEmailCapabilities);
      const issues: string[] = [];
      const recipients = emailRecipientAddresses(message).map((address) => address.toLowerCase());

      if (new Set(recipients).size !== recipients.length) {
        issues.push("to");
      }

      if (message.subject.length > 500) {
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
          (mailbox) => !Schema.is(EmailAddressSchema)(mailbox) && (mailbox.name?.length ?? 0) > 250,
        )
      ) {
        issues.push("name");
      }

      if (
        message.headers?.some(({ name }) => /^(?:x-tm-|x-zoho-|x-zeptomail-)/iu.test(name)) === true
      ) {
        issues.push("headers");
      }

      if (
        message.attachments?.some(
          (attachment) =>
            attachment.filename.length > 150 ||
            Schema.is(ZeptomailUnsupportedExtension)(
              attachment.filename.split(".").at(-1)?.toLowerCase(),
            ) ||
            (attachment.contentId !== undefined && !attachment.contentType.startsWith("image/")),
        ) === true
      ) {
        issues.push("attachments");
      }

      if (
        new TextEncoder().encode(JSON.stringify(buildZeptomailMessage(message))).byteLength >
        8_000_000
      ) {
        issues.push("body");
      }

      if (issues.length > 0) {
        return yield* new EmailInvalidMessage({
          issues: [...new Set(issues)].map((path) => ({
            path,
            problem: "ZeptoMail cannot preserve this constrained transactional intent",
          })),
        });
      }

      return undefined;
    });

    const request = Effect.fnUntraced(function* buildZeptomailRequest(
      submission: EmailSubmission,
    ): Effect.fn.Return<HttpClientRequest.HttpClientRequest, EmailRejected> {
      return yield* HttpClientRequest.post("https://cpaas.zoho.com/v1.1/email").pipe(
        HttpClientRequest.setHeader(
          "Authorization",
          `Zoho-enczapikey ${Redacted.value(configuration.apiKey)}`,
        ),
        HttpClientRequest.acceptJson,
        HttpClientRequest.bodyJson(buildZeptomailMessage(submission.message)),
        Effect.mapError(
          () => new EmailRejected({ provider: "zeptomail", reason: "invalid-message" }),
        ),
      );
    });

    const respond = Effect.fnUntraced(function* parseZeptomailAcknowledgement(
      response: HttpClientResponse.HttpClientResponse,
    ): Effect.fn.Return<EmailReceipt, EmailSubmissionError> {
      const { status } = response;

      if (status !== 200) {
        return yield* new EmailDeliveryUnknown({
          provider: "zeptomail",
          reason: status >= 500 ? "server-error" : "unexpected-status",
          status,
        });
      }

      const acknowledgement = yield* readEmailHttpJson(response, "zeptomail").pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(ZeptomailAcknowledgement)),
        Effect.mapError(
          () =>
            new EmailDeliveryUnknown({ provider: "zeptomail", reason: "invalid-response", status }),
        ),
      );

      return configuration.agentMode === "Sandbox"
        ? EmailReceiptSchema.cases.Simulated.make({
            messageId: acknowledgement.request_id,
            provider: "zeptomail",
          })
        : EmailReceiptSchema.cases.Accepted.make({
            messageId: acknowledgement.request_id,
            provider: "zeptomail",
          });
    });

    return {
      capabilities: zeptomailEmailCapabilities,
      idempotency: EmailSenderIdempotencySchema.cases.None.make({}),
      provider: "zeptomail",
      request,
      respond,
      span: "Zeptomail.submit",
      validate,
    };
  });

export const zeptomailEmailLayer = (
  options: ZeptomailEmailOptions,
  policy?: EmailDeliveryPolicy,
  observer?: EmailRetryObserver,
  restriction?: EmailRetryRestriction,
): Layer.Layer<Email, EmailConfigurationError, HttpClient.HttpClient> =>
  emailLayer(policy, observer, restriction).pipe(Layer.provide(zeptomailSenderLayer(options)));
