import { DateTime, Duration, Effect, Layer, Option, Redacted, Schema } from "effect";
import { HttpClientRequest } from "effect/http";
import type { HttpClient, HttpClientResponse } from "effect/http";
import { EmailAddressSchema, formatEmailMailbox } from "./email-address.js";
import type { EmailMailbox } from "./email-address.js";
import {
  EmailSenderCapabilitiesSchema,
  ownEmailSenderCapabilities,
  validateEmailCapabilities,
} from "./email-capabilities.js";
import type { EmailConfigurationError } from "./email-configuration-error.js";
import { parseEmailCountedReceipt } from "./email-counted-receipt.js";
import { EmailDeliveryUnknown } from "./email-delivery-unknown.js";
import type { EmailSubmissionError } from "./email-errors.js";
import { EmailHttpCredentialSchema } from "./email-http-credential.js";
import { emailHttpSenderLayer } from "./email-http-protocol.js";
import { readEmailHttpJson } from "./email-http-response.js";
import { parseEmailHttpRetryAfterMillis } from "./email-http-retry-after.js";
import { EmailInvalidMessage } from "./email-invalid-message.js";
import { EmailMessageIdSchema } from "./email-message.js";
import type { EmailMessage, EmailReceipt } from "./email-message.js";
import type { EmailAttachment } from "./email-attachment.js";
import { EmailRecipientCountsSchema, emailRecipientAddresses } from "./email-recipient-outcomes.js";
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

export const sparkpostEmailCapabilities = ownEmailSenderCapabilities(
  EmailSenderCapabilitiesSchema.make({
    attachmentContentTypes: "Explicit",
    attachments: true,
    headers: "Unique",
    inlineAttachments: true,
    metadata: true,
    scheduling: true,
    tags: { asciiOnly: false, maxCount: 0 },
  }),
);

export interface SparkpostEmailOptions {
  readonly apiKey: Redacted.Redacted;
  readonly region?: "UnitedStates" | "Europe";
}

const SparkpostConfiguration = Schema.Struct({
  apiKey: EmailHttpCredentialSchema,
  region: Schema.optionalKey(Schema.Literals(["UnitedStates", "Europe"])),
});

const SparkpostError = Schema.Struct({
  code: Schema.String.check(Schema.isPattern(/^\d{1,10}$/u)),
});

const SparkpostAcknowledgement = Schema.Struct({
  errors: Schema.optionalKey(Schema.Array(SparkpostError).check(Schema.isMaxLength(32))),
  results: Schema.Struct({
    id: EmailMessageIdSchema,
    total_accepted_recipients: EmailRecipientCountsSchema.fields.acceptedCount,
    total_rejected_recipients: EmailRecipientCountsSchema.fields.rejectedCount,
  }),
});

const SparkpostProblem = Schema.Struct({
  errors: Schema.NonEmptyArray(SparkpostError).check(Schema.isMaxLength(32)),
  results: Schema.optionalKey(Schema.Null),
});

const sparkpostMailbox = (mailbox: EmailMailbox) =>
  Schema.is(EmailAddressSchema)(mailbox)
    ? { email: mailbox }
    : { email: mailbox.address, name: mailbox.name };

const sparkpostAttachment = (attachment: EmailAttachment) => ({
  data: attachment.contentBase64,
  name: attachment.filename,
  type: attachment.contentType,
});

const classifySparkpostRejection = Effect.fnUntraced(function* classifySparkpostRejection(
  response: HttpClientResponse.HttpClientResponse,
): Effect.fn.Return<never, EmailSubmissionError> {
  const { status } = response;

  if (status >= 500) {
    return yield* new EmailDeliveryUnknown({
      provider: "sparkpost",
      reason: "server-error",
      status,
    });
  }

  if (![400, 401, 403, 404, 405, 409, 413, 415, 420, 422].includes(status)) {
    return yield* new EmailDeliveryUnknown({
      provider: "sparkpost",
      reason: "unexpected-status",
      status,
    });
  }

  const problem = yield* readEmailHttpJson(response, "sparkpost").pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(SparkpostProblem)),
    Effect.option,
  );

  if (Option.isNone(problem)) {
    return yield* new EmailDeliveryUnknown({
      provider: "sparkpost",
      reason: "invalid-response",
      status,
    });
  }

  if (status === 409) {
    if (problem.value.errors.every((error) => error.code === "1600")) {
      return yield* new EmailRejected({
        provider: "sparkpost",
        reason: "idempotency-conflict",
        status,
      });
    }

    if (problem.value.errors.every((error) => error.code === "1601")) {
      return yield* Option.match(parseEmailHttpRetryAfterMillis(response.headers["retry-after"]), {
        onNone: () =>
          new EmailDeliveryUnknown({
            provider: "sparkpost",
            reason: "idempotency-in-progress",
            status,
          }),
        onSome: (retryAfterMillis) =>
          new EmailDeliveryUnknown({
            provider: "sparkpost",
            reason: "idempotency-in-progress",
            retryAfterMillis,
            status,
          }),
      });
    }

    return yield* new EmailDeliveryUnknown({
      provider: "sparkpost",
      reason: "unexpected-status",
      status,
    });
  }

  if (problem.value.errors.some((error) => error.code === "2000")) {
    return yield* new EmailDeliveryUnknown({
      provider: "sparkpost",
      reason: "invalid-response",
      status,
    });
  }

  if (status === 401) {
    return yield* new EmailRejected({ provider: "sparkpost", reason: "authentication", status });
  }

  if ([403, 404, 405, 420].includes(status)) {
    return yield* new EmailRejected({ provider: "sparkpost", reason: "rejected", status });
  }

  if ([400, 413, 415, 422].includes(status)) {
    return yield* new EmailRejected({ provider: "sparkpost", reason: "invalid-message", status });
  }

  return yield* new EmailDeliveryUnknown({
    provider: "sparkpost",
    reason: "unexpected-status",
    status,
  });
});

export const sparkpostSenderLayer = (
  options: SparkpostEmailOptions,
): Layer.Layer<EmailSender, EmailConfigurationError, HttpClient.HttpClient> =>
  emailHttpSenderLayer(SparkpostConfiguration, options, (configuration) => {
    const validate = Effect.fnUntraced(function* validateSparkpostIntent(
      message: EmailMessage,
    ): Effect.fn.Return<void, EmailInvalidMessage> {
      yield* validateEmailCapabilities(message, sparkpostEmailCapabilities);

      const issues: string[] = [];

      if (message.cc !== undefined) {
        issues.push("cc");
      }

      if (message.bcc !== undefined) {
        issues.push("bcc");
      }

      if (message.replyTo !== undefined && message.replyTo.length !== 1) {
        issues.push("replyTo");
      }

      const addresses = emailRecipientAddresses(message);

      if (new Set(addresses.map((address) => address.toLowerCase())).size !== addresses.length) {
        issues.push("to");
      }

      if (message.sendAt !== undefined) {
        const scheduled = DateTime.toEpochMillis(message.sendAt);
        const delta = scheduled - DateTime.toEpochMillis(yield* DateTime.now);

        if (
          scheduled % 1000 !== 0 ||
          delta <= 0 ||
          delta > 3 * 24 * 60 * 60 * 1000 ||
          DateTime.formatIso(message.sendAt).length !== 24
        ) {
          issues.push("sendAt");
        }
      }

      if (
        message.metadata !== undefined &&
        new TextEncoder().encode(JSON.stringify(message.metadata)).byteLength > 10_000
      ) {
        issues.push("metadata");
      }

      if (
        message.headers !== undefined &&
        message.headers.some(
          (header) =>
            header.name.toLowerCase().startsWith("x-msys-") ||
            ["message-id", "list-unsubscribe", "list-unsubscribe-post"].includes(
              header.name.toLowerCase(),
            ),
        )
      ) {
        issues.push("headers");
      }

      if (
        message.attachments !== undefined &&
        message.attachments.some(
          (attachment) =>
            attachment.contentId !== undefined &&
            (String(attachment.contentId) !== String(attachment.filename) ||
              !attachment.contentType.startsWith("image/")),
        )
      ) {
        issues.push("attachments");
      }

      if (issues.length > 0) {
        return yield* new EmailInvalidMessage({
          issues: issues.map((path) => ({
            path,
            problem:
              path === "sendAt"
                ? "SparkPost scheduling requires a future whole UTC second within three days and a four-digit year"
                : "SparkPost cannot preserve this intent",
          })),
        });
      }

      return undefined;
    });

    const request = Effect.fnUntraced(function* buildSparkpostRequest(
      submission: EmailSubmission,
    ): Effect.fn.Return<HttpClientRequest.HttpClientRequest, EmailRejected> {
      const { message, idempotencyKey } = submission;

      const attachments = message.attachments
        ?.filter((attachment) => attachment.contentId === undefined)
        .map(sparkpostAttachment);

      const inlineImages = message.attachments
        ?.filter((attachment) => attachment.contentId !== undefined)
        .map(sparkpostAttachment);

      const headerTo = message.to.map(formatEmailMailbox).join(", ");

      const payload = {
        content: {
          attachments,
          from: sparkpostMailbox(message.from),
          headers:
            message.headers === undefined
              ? undefined
              : Object.fromEntries(message.headers.map((header) => [header.name, header.value])),
          html: message.body.html,
          inline_images: inlineImages,
          reply_to:
            message.replyTo === undefined
              ? undefined
              : message.replyTo.map(formatEmailMailbox).join(", "),
          subject: message.subject,
          text: message.body.text,
        },
        metadata: message.metadata,
        options: {
          click_tracking: false,
          initial_open: false,
          inline_css: false,
          open_tracking: false,
          perform_substitutions: false,
          sandbox: false,
          skip_suppression: false,
          start_time:
            message.sendAt === undefined
              ? undefined
              : DateTime.formatIso(message.sendAt).replace(/\.000Z$/u, "Z"),
          transactional: false,
        },
        recipients: message.to.map((mailbox) => ({
          address: { email: sparkpostMailbox(mailbox).email, header_to: headerTo },
        })),
      };

      const origin =
        configuration.region === "Europe"
          ? "https://api.eu.sparkpost.com"
          : "https://api.sparkpost.com";

      let httpRequest = HttpClientRequest.post(`${origin}/api/v1/transmissions`).pipe(
        HttpClientRequest.setHeader("Authorization", Redacted.value(configuration.apiKey)),
        HttpClientRequest.acceptJson,
      );

      if (idempotencyKey !== undefined) {
        httpRequest = HttpClientRequest.setHeader(httpRequest, "Idempotency-Key", idempotencyKey);
      }

      return yield* HttpClientRequest.bodyJson(httpRequest, payload).pipe(
        Effect.mapError(
          () => new EmailRejected({ provider: "sparkpost", reason: "invalid-message" }),
        ),
      );
    });

    const respond = Effect.fnUntraced(function* readSparkpostReceipt(
      response: HttpClientResponse.HttpClientResponse,
      message: EmailMessage,
    ): Effect.fn.Return<EmailReceipt, EmailSubmissionError> {
      if (response.status !== 200) {
        return yield* classifySparkpostRejection(response);
      }

      const invalid = () =>
        new EmailDeliveryUnknown({
          provider: "sparkpost",
          reason: "invalid-response",
          status: response.status,
        });

      const acknowledgement = yield* readEmailHttpJson(response, "sparkpost").pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(SparkpostAcknowledgement)),
        Effect.mapError(invalid),
      );

      if (
        (acknowledgement.errors !== undefined &&
          acknowledgement.errors.some((error) => error.code !== "2000")) ||
        (acknowledgement.errors?.length !== undefined &&
          acknowledgement.errors.length > 0 &&
          acknowledgement.results.total_rejected_recipients === 0)
      ) {
        return yield* invalid();
      }

      return yield* parseEmailCountedReceipt(
        message,
        {
          acceptedCount: acknowledgement.results.total_accepted_recipients,
          rejectedCount: acknowledgement.results.total_rejected_recipients,
        },
        "sparkpost",
        response.status,
        acknowledgement.results.id,
      );
    });

    return {
      capabilities: sparkpostEmailCapabilities,
      idempotency: EmailSenderIdempotencySchema.cases.Native.make({
        keyFormat: "AlphanumericDotUnderscoreHyphen",
        maxKeyLength: 255,
        retention: Duration.hours(24),
      }),
      provider: "sparkpost",
      request,
      respond,
      span: "SparkPost.submit",
      validate,
    };
  });

export const sparkpostEmailLayer = (
  options: SparkpostEmailOptions,
  policy?: EmailDeliveryPolicy,
  observer?: EmailRetryObserver,
  restriction?: EmailRetryRestriction,
): Layer.Layer<Email, EmailConfigurationError, HttpClient.HttpClient> =>
  emailLayer(policy, observer, restriction).pipe(Layer.provide(sparkpostSenderLayer(options)));
