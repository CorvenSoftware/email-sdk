import { Effect, Layer, Option, Redacted, Schema } from "effect";
import { HttpClientRequest } from "effect/http";
import type { HttpClient, HttpClientResponse } from "effect/http";
import { EmailAddressSchema, emailMailboxAddress } from "./email-address.js";
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
import { parseEmailHttpRetryAfterMillis } from "./email-http-retry-after.js";
import { EmailInvalidMessage } from "./email-invalid-message.js";
import { EmailReceiptSchema } from "./email-message.js";
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

export const graphEmailCapabilities = ownEmailSenderCapabilities(
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

export interface GraphEmailOptions {
  readonly accessToken: Redacted.Redacted;
  readonly mailboxId: string;
  readonly mailboxAddress: string;
  readonly senderIdentity: "OwnerOrSendAs";
  readonly mailFlow: "ProviderUnmodified";
  readonly sentItems: "Save" | "DoNotSave";
}

const GraphConfiguration = Schema.Struct({
  accessToken: EmailHttpCredentialSchema,
  mailFlow: Schema.Literal("ProviderUnmodified"),
  mailboxAddress: Schema.toEncoded(EmailAddressSchema),
  mailboxId: Schema.String.check(Schema.isUUID()),
  senderIdentity: Schema.Literal("OwnerOrSendAs"),
  sentItems: Schema.Literals(["Save", "DoNotSave"]),
});

const GraphInnerProblem = Schema.Struct({
  "client-request-id": Schema.optionalKey(Schema.String),
  code: Schema.optionalKey(Schema.Literals(["ErrorSendAsDenied", "ErrorAccessDenied", "429"])),
  date: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
  "request-id": Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.Literals(["403", "429"])),
});

const GraphProblem = Schema.Struct({
  error: Schema.Struct({
    code: Schema.Literals(["ErrorSendAsDenied", "ErrorAccessDenied", "TooManyRequests"]),
    details: Schema.optionalKey(Schema.Array(Schema.Never)),
    innerError: Schema.optionalKey(GraphInnerProblem),
    innererror: Schema.optionalKey(GraphInnerProblem),
    message: Schema.optionalKey(Schema.String),
  }),
});

const graphRecipient = (mailbox: EmailMailbox) => ({
  emailAddress: Schema.is(EmailAddressSchema)(mailbox) ? { address: mailbox } : mailbox,
});

const buildGraphMessage = (message: EmailMessage, sentItems: GraphEmailOptions["sentItems"]) => ({
  message: {
    attachments: message.attachments?.map((attachment) => ({
      "@odata.type": "#microsoft.graph.fileAttachment",
      contentBytes: attachment.contentBase64,
      contentId: attachment.contentId,
      contentType: attachment.contentType,
      isInline: attachment.contentId !== undefined,
      name: attachment.filename,
    })),
    bccRecipients: message.bcc?.map(graphRecipient),
    body:
      message.body.html === undefined
        ? { content: message.body.text, contentType: "Text" }
        : { content: message.body.html, contentType: "HTML" },
    ccRecipients: message.cc?.map(graphRecipient),
    from: graphRecipient(message.from),
    internetMessageHeaders: message.headers,
    isDeliveryReceiptRequested: false,
    isReadReceiptRequested: false,
    replyTo: message.replyTo?.map(graphRecipient),
    subject: message.subject,
    toRecipients: message.to.map(graphRecipient),
  },
  saveToSentItems: sentItems === "DoNotSave" ? false : undefined,
});

const parseGraphRejection = Effect.fnUntraced(function* parseGraphRejection(
  response: HttpClientResponse.HttpClientResponse,
): Effect.fn.Return<never, EmailSubmissionError> {
  const { status } = response;

  if (status !== 403 && status !== 429) {
    return yield* new EmailDeliveryUnknown({
      provider: "graph",
      reason: status >= 500 ? "server-error" : "unexpected-status",
      status,
    });
  }

  const problem = yield* readEmailHttpJson(response, "graph").pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(GraphProblem, { onExcessProperty: "error" })),
    Effect.mapError(
      () => new EmailDeliveryUnknown({ provider: "graph", reason: "invalid-response", status }),
    ),
  );

  const { error } = problem;
  const isRateLimit = status === 429 && error.code === "TooManyRequests";

  const isDenied =
    status === 403 && (error.code === "ErrorSendAsDenied" || error.code === "ErrorAccessDenied");

  const consistent = [error.innerError, error.innererror].every(
    (inner) =>
      inner === undefined ||
      ((inner.status === undefined || inner.status === String(status)) &&
        (inner.code === undefined || inner.code === error.code || inner.code === String(status))),
  );

  if ((!isRateLimit && !isDenied) || !consistent) {
    return yield* new EmailDeliveryUnknown({
      provider: "graph",
      reason: "invalid-response",
      status,
    });
  }

  const retryAfter = isRateLimit
    ? parseEmailHttpRetryAfterMillis(response.headers["retry-after"])
    : Option.none();

  return yield* Option.match(retryAfter, {
    onNone: () =>
      new EmailRejected({
        provider: "graph",
        reason: isRateLimit ? "rate-limited" : "authentication",
        status,
      }),
    onSome: (retryAfterMillis) =>
      new EmailRejected({ provider: "graph", reason: "rate-limited", retryAfterMillis, status }),
  });
});

export const graphSenderLayer = (
  options: GraphEmailOptions,
): Layer.Layer<EmailSender, EmailConfigurationError, HttpClient.HttpClient> =>
  emailHttpSenderLayer(GraphConfiguration, options, (configuration) => {
    const validate = Effect.fnUntraced(function* validateGraphIntent(
      message: EmailMessage,
    ): Effect.fn.Return<void, EmailInvalidMessage> {
      yield* validateEmailCapabilities(message, graphEmailCapabilities);
      const issues: string[] = [];

      if (
        emailMailboxAddress(message.from).toLowerCase() !==
        configuration.mailboxAddress.toLowerCase()
      ) {
        issues.push("from");
      }

      if (message.body.html !== undefined && message.body.text !== undefined) {
        issues.push("body");
      }

      for (const [path, addresses] of [
        ["to", emailRecipientAddresses(message)],
        ["replyTo", (message.replyTo ?? []).map(emailMailboxAddress)],
      ] as const) {
        const folded = addresses.map((address) => address.toLowerCase());

        if (new Set(folded).size !== folded.length) {
          issues.push(path);
        }
      }

      if (
        (message.headers?.length ?? 0) > 5 ||
        message.headers?.some(
          ({ name }) =>
            !/^x-/iu.test(name) ||
            /^(?:x-ms-|x-microsoft-|x-exchange-|x-forefront-|x-auto-response-suppress$|x-originating-ip$)/iu.test(
              name,
            ),
        ) === true
      ) {
        issues.push("headers");
      }

      if (
        new TextEncoder().encode(
          JSON.stringify(buildGraphMessage(message, configuration.sentItems)),
        ).byteLength > 3_000_000
      ) {
        issues.push("body");
      }

      if (issues.length > 0) {
        return yield* new EmailInvalidMessage({
          issues: [...new Set(issues)].map((path) => ({
            path,
            problem: "Microsoft Graph cannot preserve this constrained mailbox intent",
          })),
        });
      }

      return undefined;
    });

    const request = Effect.fnUntraced(function* buildGraphRequest(
      submission: EmailSubmission,
    ): Effect.fn.Return<HttpClientRequest.HttpClientRequest, EmailRejected> {
      return yield* HttpClientRequest.post(
        `https://graph.microsoft.com/v1.0/users/${configuration.mailboxId}/sendMail`,
      ).pipe(
        HttpClientRequest.bearerToken(Redacted.value(configuration.accessToken)),
        HttpClientRequest.acceptJson,
        HttpClientRequest.bodyJson(buildGraphMessage(submission.message, configuration.sentItems)),
        Effect.mapError(() => new EmailRejected({ provider: "graph", reason: "invalid-message" })),
      );
    });

    const respond = Effect.fnUntraced(function* parseGraphAcknowledgement(
      response: HttpClientResponse.HttpClientResponse,
    ): Effect.fn.Return<EmailReceipt, EmailSubmissionError> {
      if (response.status !== 202) {
        return yield* parseGraphRejection(response);
      }

      return Object.freeze(EmailReceiptSchema.cases.Accepted.make({ provider: "graph" }));
    });

    return {
      capabilities: graphEmailCapabilities,
      idempotency: EmailSenderIdempotencySchema.cases.None.make({}),
      provider: "graph",
      request,
      respond,
      span: "Graph.submit",
      validate,
    };
  });

export const graphEmailLayer = (
  options: GraphEmailOptions,
  policy?: EmailDeliveryPolicy,
  observer?: EmailRetryObserver,
  restriction?: EmailRetryRestriction,
): Layer.Layer<Email, EmailConfigurationError, HttpClient.HttpClient> =>
  emailLayer(policy, observer, restriction).pipe(Layer.provide(graphSenderLayer(options)));
