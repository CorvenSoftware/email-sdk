import { Duration, Effect, Layer, Match, Option, Redacted, Schema } from "effect";
import { HttpClientRequest } from "effect/http";
import type { HttpClient, HttpClientResponse } from "effect/http";
import { EmailAddressSchema, emailMailboxAddress } from "./email-address.js";
import type { EmailAddress, EmailMailbox } from "./email-address.js";
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
import { formatEmailTagLabel } from "./email-message-metadata.js";
import { EmailInvalidMessage } from "./email-invalid-message.js";
import { EmailMessageIdSchema, EmailReceiptSchema } from "./email-message.js";
import type { EmailMessage, EmailReceipt } from "./email-message.js";
import { partitionEmailSuppressions } from "./email-recipient-outcomes.js";
import { parseEmailPartialSuppressionReceipt } from "./email-suppression-receipt.js";
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

export const heloEmailCapabilities = ownEmailSenderCapabilities(
  EmailSenderCapabilitiesSchema.make({
    attachmentContentTypes: "Both",
    attachments: true,
    headers: "Unique",
    inlineAttachments: true,
    metadata: true,
    scheduling: false,
    tags: { asciiOnly: false, maxCount: 5 },
  }),
);

export interface HeloEmailOptions {
  readonly apiKey: Redacted.Redacted;
  readonly channelId?: string;
  readonly channelMode: "Live" | "Sandbox";
}

const HeloConfiguration = Schema.Struct({
  apiKey: EmailHttpCredentialSchema,
  channelId: Schema.optionalKey(Schema.String.check(Schema.isUUID())),
  channelMode: Schema.Literals(["Live", "Sandbox"]),
});

const HeloAcknowledgement = Schema.Struct({
  errorCode: Schema.optionalKey(Schema.Null),
  messageId: EmailMessageIdSchema.check(Schema.isUUID()),
  status: Schema.Literal("accepted"),
  suppressions: Schema.optionalKey(Schema.Array(EmailAddressSchema).check(Schema.isMaxLength(50))),
});

const HeloFailedResponse = Schema.Struct({
  errorCode: Schema.String.check(Schema.isMaxLength(128)),
  messageId: Schema.optionalKey(Schema.Null),
  status: Schema.Literal("failed"),
  suppressions: Schema.optionalKey(Schema.Array(EmailAddressSchema).check(Schema.isMaxLength(50))),
});

const HeloProblemResponse = Schema.Struct({
  code: Schema.String.check(Schema.isMaxLength(128)),
  messageId: Schema.optionalKey(Schema.Null),
  status: Schema.optionalKey(Schema.Int),
  suppressions: Schema.optionalKey(Schema.Array(EmailAddressSchema).check(Schema.isMaxLength(50))),
});

const formatHeloMailbox = (mailbox: EmailMailbox) =>
  Schema.is(EmailAddressSchema)(mailbox)
    ? { email: mailbox }
    : { email: mailbox.address, name: mailbox.name };

const heloCompleteSuppression = Effect.fnUntraced(function* heloCompleteSuppression(
  message: EmailMessage,
  status: number,
  suppressionAddresses?: readonly EmailAddress[],
): Effect.fn.Return<EmailReceipt, EmailDeliveryUnknown> {
  if (suppressionAddresses !== undefined) {
    const partition = yield* partitionEmailSuppressions(
      message,
      suppressionAddresses,
      "helo",
      status,
    );

    if (partition.accepted.length !== 0) {
      return yield* new EmailDeliveryUnknown({
        provider: "helo",
        reason: "invalid-response",
        status,
      });
    }
  }

  const suppressed = yield* Schema.decodeUnknownEffect(Schema.NonEmptyArray(EmailAddressSchema))(
    [...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])].map(emailMailboxAddress),
  ).pipe(
    Effect.mapError(
      () => new EmailDeliveryUnknown({ provider: "helo", reason: "invalid-response", status }),
    ),
  );

  const receipt = EmailReceiptSchema.cases.Suppressed.make({ provider: "helo", suppressed });
  Object.freeze(receipt.suppressed);

  return Object.freeze(receipt);
});

const classifyHeloFailureCode = (code: string) =>
  Match.value(code).pipe(
    Match.when(
      (value) =>
        value === "invalid_json" || value === "validation_failed" || value === "templating_error",
      () => "invalid-message" as const,
    ),
    Match.when(
      (value) =>
        [
          "resource_limit_exceeded",
          "channel_not_found",
          "invalid_channel",
          "domain_unverified",
          "account_forbidden",
          "recipient_forbidden",
          "send_limit_exceeded",
        ].includes(value),
      () => "rejected" as const,
    ),
    Match.orElse(() => "invalid-response" as const),
  );

const readHeloProblemResponse = Effect.fnUntraced(function* readHeloProblemResponse(
  response: HttpClientResponse.HttpClientResponse,
): Effect.fn.Return<Option.Option<typeof HeloProblemResponse.Type>, EmailDeliveryUnknown> {
  const problem = yield* readEmailHttpJson(response, "helo").pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(HeloProblemResponse)),
    Effect.option,
  );

  if (Option.isSome(problem)) {
    const body = problem.value;

    if (
      (body.status !== undefined && body.status !== response.status) ||
      (body.code === "recipients_suppressed" && response.status !== 422) ||
      ((body.suppressions?.length ?? 0) > 0 && body.code !== "recipients_suppressed")
    ) {
      return yield* new EmailDeliveryUnknown({
        provider: "helo",
        reason: "invalid-response",
        status: response.status,
      });
    }
  }

  return problem;
});

const classifyHeloRejection = Effect.fnUntraced(function* classifyHeloRejection(
  response: HttpClientResponse.HttpClientResponse,
  message: EmailMessage,
): Effect.fn.Return<EmailReceipt, EmailSubmissionError> {
  const { status } = response;

  if (status >= 500) {
    return yield* new EmailDeliveryUnknown({ provider: "helo", reason: "server-error", status });
  }

  if (status === 409) {
    return yield* new EmailDeliveryUnknown({
      provider: "helo",
      reason: "unexpected-status",
      status,
    });
  }

  if (status === 422 || status === 429) {
    const problem = yield* readHeloProblemResponse(response);
    const code = Option.isSome(problem) ? problem.value.code : "unclassified";

    if (status === 422 && code === "recipients_suppressed" && Option.isSome(problem)) {
      return yield* heloCompleteSuppression(message, status, problem.value.suppressions);
    }

    if (status === 429 && code !== "send_limit_exceeded" && code !== "resource_limit_exceeded") {
      return yield* Option.match(parseEmailHttpRetryAfterMillis(response.headers["retry-after"]), {
        onNone: () => new EmailRejected({ provider: "helo", reason: "rate-limited", status }),
        onSome: (retryAfterMillis) =>
          new EmailRejected({ provider: "helo", reason: "rate-limited", retryAfterMillis, status }),
      });
    }

    if (status === 429) {
      return yield* new EmailRejected({ provider: "helo", reason: "rejected", status });
    }

    const reason = classifyHeloFailureCode(code);

    if (reason === "invalid-response") {
      return yield* new EmailDeliveryUnknown({ provider: "helo", reason, status });
    }

    return yield* new EmailRejected({ provider: "helo", reason, status });
  }

  const reason = Match.value(status).pipe(
    Match.when(400, () => "invalid-message" as const),
    Match.when(401, () => "authentication" as const),
    Match.when(
      (code) => code === 403 || code === 404 || code === 405,
      () => "rejected" as const,
    ),
    Match.orElse(() => "unexpected-status" as const),
  );

  if (reason === "unexpected-status") {
    return yield* new EmailDeliveryUnknown({ provider: "helo", reason, status });
  }

  return yield* new EmailRejected({ provider: "helo", reason, status });
});

export const heloSenderLayer = (
  options: HeloEmailOptions,
): Layer.Layer<EmailSender, EmailConfigurationError, HttpClient.HttpClient> =>
  emailHttpSenderLayer(HeloConfiguration, options, (configuration) => {
    const validate = Effect.fnUntraced(function* validateHeloIntent(
      message: EmailMessage,
    ): Effect.fn.Return<void, EmailInvalidMessage> {
      yield* validateEmailCapabilities(message, heloEmailCapabilities);
      const issues = [];

      if (message.subject.length > 256) {
        issues.push({ path: "subject", problem: "Helo subjects must fit within 256 characters" });
      }

      if (
        message.tags?.some(
          ({ name, value }) => name.includes(":") || name.length + value.length + 1 > 100,
        ) === true
      ) {
        issues.push({
          path: "tags",
          problem: "Helo tags require colon-free names and name:value pairs up to 100 characters",
        });
      }

      if (
        message.metadata !== undefined &&
        (Object.keys(message.metadata).length > 10 ||
          Object.entries(message.metadata).some(
            ([name, value]) => name.length > 50 || value.length > 100,
          ))
      ) {
        issues.push({
          path: "metadata",
          problem:
            "Helo metadata allows ten fields with keys up to 50 and values up to 100 characters",
        });
      }

      if (
        message.headers !== undefined &&
        (message.headers.reduce((size, { name, value }) => size + name.length + value.length, 0) >
          5000 ||
          message.headers.some(({ name }) => name.toLowerCase().startsWith("x-helo-")))
      ) {
        issues.push({
          path: "headers",
          problem: "Helo headers must fit within 5000 characters and cannot override Helo controls",
        });
      }

      const recipients = [...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])];

      if (
        new Set(recipients.map((mailbox) => emailMailboxAddress(mailbox).toLowerCase())).size !==
        recipients.length
      ) {
        issues.push({
          path: "to",
          problem: "Helo recipient addresses must be distinct for suppression evidence",
        });
      }

      if (issues.length > 0) {
        return yield* new EmailInvalidMessage({ issues });
      }

      return undefined;
    });

    const request = Effect.fnUntraced(function* buildHeloRequest(
      submission: EmailSubmission,
    ): Effect.fn.Return<HttpClientRequest.HttpClientRequest, EmailRejected> {
      const { message } = submission;

      const unkeyed = yield* HttpClientRequest.post(
        "https://api.helohq.com/send/transactional",
      ).pipe(
        HttpClientRequest.bearerToken(Redacted.value(configuration.apiKey)),
        HttpClientRequest.acceptJson,
        HttpClientRequest.bodyJson({
          attachments: message.attachments?.map((attachment) => ({
            content: attachment.contentBase64,
            contentId: attachment.contentId,
            contentType: emailAttachmentMimeType(attachment),
            disposition: attachment.contentId === undefined ? "attachment" : "inline",
            fileName: attachment.filename,
          })),
          bcc: message.bcc?.map(formatHeloMailbox),
          cc: message.cc?.map(formatHeloMailbox),
          from: formatHeloMailbox(message.from),
          headers:
            message.headers === undefined
              ? undefined
              : Object.fromEntries(message.headers.map(({ name, value }) => [name, value])),
          html: message.body.html,
          metadata: message.metadata,
          replyTo: message.replyTo?.map(formatHeloMailbox),
          subject: message.subject,
          tags: message.tags?.map(formatEmailTagLabel),
          text: message.body.text,
          to: message.to.map(formatHeloMailbox),
          tracking: { links: false, opens: false },
        }),
        Effect.mapError(() => new EmailRejected({ provider: "helo", reason: "invalid-message" })),
      );

      const channelRequest =
        configuration.channelId === undefined
          ? unkeyed
          : HttpClientRequest.setHeader(unkeyed, "X-Helo-Channel-Id", configuration.channelId);

      return submission.idempotencyKey === undefined
        ? channelRequest
        : HttpClientRequest.setHeader(
            channelRequest,
            "X-Helo-Idempotency-Key",
            submission.idempotencyKey,
          );
    });

    const respond = Effect.fnUntraced(function* readHeloAcknowledgement(
      response: HttpClientResponse.HttpClientResponse,
      message: EmailMessage,
    ): Effect.fn.Return<EmailReceipt, EmailSubmissionError> {
      if (response.status !== 200) {
        return yield* classifyHeloRejection(response, message);
      }

      const invalid = () =>
        new EmailDeliveryUnknown({
          provider: "helo",
          reason: "invalid-response",
          status: response.status,
        });

      const body = yield* readEmailHttpJson(response, "helo");
      const failed = Schema.decodeUnknownOption(HeloFailedResponse)(body);

      if (Option.isSome(failed)) {
        if (failed.value.errorCode === "recipients_suppressed") {
          return yield* heloCompleteSuppression(
            message,
            response.status,
            failed.value.suppressions,
          );
        }

        if ((failed.value.suppressions?.length ?? 0) > 0) {
          return yield* invalid();
        }

        const reason = classifyHeloFailureCode(failed.value.errorCode);

        if (reason === "invalid-response") {
          return yield* invalid();
        }

        return yield* new EmailRejected({ provider: "helo", reason, status: response.status });
      }

      const acknowledgement = yield* Schema.decodeUnknownEffect(HeloAcknowledgement)(body).pipe(
        Effect.mapError(invalid),
      );

      const suppressions = acknowledgement.suppressions ?? [];

      const partition =
        suppressions.length === 0
          ? undefined
          : yield* partitionEmailSuppressions(message, suppressions, "helo", response.status);

      if (partition !== undefined && partition.accepted.length === 0) {
        return yield* invalid();
      }

      if (configuration.channelMode === "Sandbox") {
        return Object.freeze(
          EmailReceiptSchema.cases.Simulated.make({
            messageId: acknowledgement.messageId,
            provider: "helo",
          }),
        );
      }

      if (partition !== undefined) {
        return yield* parseEmailPartialSuppressionReceipt(
          partition,
          "helo",
          response.status,
          acknowledgement.messageId,
        );
      }

      return Object.freeze(
        EmailReceiptSchema.cases.Accepted.make({
          messageId: acknowledgement.messageId,
          provider: "helo",
        }),
      );
    });

    return {
      capabilities: heloEmailCapabilities,
      idempotency: EmailSenderIdempotencySchema.cases.Native.make({
        maxKeyLength: 36,
        retention: Duration.hours(1),
      }),
      provider: "helo",
      request,
      respond,
      span: "Helo.submit",
      validate,
    };
  });

export const heloEmailLayer = (
  options: HeloEmailOptions,
  policy?: EmailDeliveryPolicy,
  observer?: EmailRetryObserver,
  restriction?: EmailRetryRestriction,
): Layer.Layer<Email, EmailConfigurationError, HttpClient.HttpClient> =>
  emailLayer(policy, observer, restriction).pipe(Layer.provide(heloSenderLayer(options)));
