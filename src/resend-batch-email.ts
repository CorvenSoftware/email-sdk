import { Context, Duration, Effect, Layer, Option, Redacted, Result, Schema } from "effect";
import type { Scope } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import type { HttpClientResponse } from "effect/http";
import {
  EmailSenderCapabilitiesSchema,
  ownEmailSenderCapabilities,
  validateEmailCapabilities,
} from "./email-capabilities.js";
import { EmailConfigurationError } from "./email-configuration-error.js";
import { EmailDeliveryUnknown } from "./email-delivery-unknown.js";
import type { EmailSendError, EmailSubmissionError } from "./email-errors.js";
import { EmailHttpCredentialSchema } from "./email-http-credential.js";
import { readEmailHttpJson } from "./email-http-response.js";
import { emailInputIssues } from "./email-input-issues.js";
import { EmailInvalidMessage } from "./email-invalid-message.js";
import { EmailInvalidOptions } from "./email-invalid-options.js";
import {
  EmailIdempotencyKeySchema,
  EmailMessageIdSchema,
  EmailMessageSchema,
  EmailReceiptSchema,
  ownEmailMessage,
} from "./email-message.js";
import type { EmailReceipt } from "./email-message.js";
import type { EmailPreflight } from "./email-preflight.js";
import { EmailRejected } from "./email-rejected.js";
import { EmailSenderIdempotencySchema, ownEmailSenderIdempotency } from "./email-sender.js";
import { emailOperationSpan } from "./email-tracing.js";
import { protectEmailUnsettledCause } from "./email-unsettled-cause.js";
import { buildResendEmailPayload } from "./resend-email-payload.js";
import type { ResendEmailOptions } from "./resend-email-sender.js";

export const ResendBatchMessagesSchema = Schema.NonEmptyArray(EmailMessageSchema).check(
  Schema.isMaxLength(100),
);

export type ResendBatchMessagesInput = typeof ResendBatchMessagesSchema.Encoded;

export const ResendBatchEmailOptionsSchema = Schema.Struct({
  idempotencyKey: Schema.optionalKey(EmailIdempotencyKeySchema),
});

export type ResendBatchEmailOptionsInput = typeof ResendBatchEmailOptionsSchema.Encoded;

export type ResendBatchEmailResult = Result.Result<EmailReceipt, EmailDeliveryUnknown>;

const resendBatchCapabilities = ownEmailSenderCapabilities(
  EmailSenderCapabilitiesSchema.make({
    attachmentContentTypes: "None",
    attachments: false,
    headers: "Unique",
    inlineAttachments: false,
    metadata: false,
    scheduling: false,
    tags: Object.freeze({ asciiOnly: true, maxCount: 75 }),
  }),
);

export const resendBatchEmailProfile: EmailPreflight = Object.freeze({
  capabilities: resendBatchCapabilities,
  idempotency: ownEmailSenderIdempotency(
    EmailSenderIdempotencySchema.cases.Native.make({
      maxKeyLength: 256,
      retention: Duration.hours(24),
    }),
  ),
  provider: "resend",
  validate: (message) => validateEmailCapabilities(message, resendBatchCapabilities),
});

export interface IResendBatchEmail {
  readonly send: (
    messages: ResendBatchMessagesInput,
    options?: ResendBatchEmailOptionsInput,
  ) => Effect.Effect<readonly ResendBatchEmailResult[], EmailSendError>;
}

export class ResendBatchEmail extends Context.Service<ResendBatchEmail, IResendBatchEmail>()(
  "@corvencore/email-sdk/ResendBatchEmail",
) {}

const ResendBatchConfiguration = Schema.Struct({ apiKey: EmailHttpCredentialSchema });

const ResendBatchAcknowledgement = Schema.Struct({ id: EmailMessageIdSchema });

const ResendBatchResponse = Schema.Struct({
  data: Schema.Array(Schema.Unknown).check(Schema.isMaxLength(100)),
  errors: Schema.optionalKey(Schema.Never),
});

const ResendBatchError = Schema.Struct({ name: Schema.String });

const rejectResendBatch = Effect.fnUntraced(function* rejectResendBatch(
  response: HttpClientResponse.HttpClientResponse,
  keyed: boolean,
): Effect.fn.Return<never, EmailSubmissionError> {
  const { status } = response;

  if (status === 403 || status === 429 || (status === 409 && keyed)) {
    const body = yield* readEmailHttpJson(response, "resend").pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ResendBatchError)),
      protectEmailUnsettledCause,
      Effect.option,
    );

    const name = Option.isSome(body) ? body.value.name : undefined;

    if (status === 403) {
      return yield* new EmailRejected({
        provider: "resend",
        reason: name === "validation_error" ? "invalid-message" : "authentication",
        status,
      });
    }

    if (status === 429) {
      return yield* new EmailRejected({
        provider: "resend",
        reason: name === "rate_limit_exceeded" ? "rate-limited" : "rejected",
        status,
      });
    }

    if (name === "invalid_idempotent_request") {
      return yield* new EmailRejected({
        provider: "resend",
        reason: "idempotency-conflict",
        status,
      });
    }

    if (name === "concurrent_idempotent_requests") {
      return yield* new EmailDeliveryUnknown({
        provider: "resend",
        reason: "idempotency-in-progress",
        status,
      });
    }
  }

  if (status === 400 || status === 422) {
    return yield* new EmailRejected({ provider: "resend", reason: "invalid-message", status });
  }

  if (status === 401) {
    return yield* new EmailRejected({ provider: "resend", reason: "authentication", status });
  }

  return yield* new EmailDeliveryUnknown({
    provider: "resend",
    reason: status >= 500 ? "server-error" : "unexpected-status",
    status,
  });
});

const readResendBatchResults = Effect.fnUntraced(function* readResendBatchResults(
  response: HttpClientResponse.HttpClientResponse,
  count: number,
): Effect.fn.Return<readonly ResendBatchEmailResult[], EmailDeliveryUnknown> {
  const unknown = () =>
    new EmailDeliveryUnknown({
      provider: "resend",
      reason: "invalid-response",
      status: response.status,
    });

  const body = yield* readEmailHttpJson(response, "resend").pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(ResendBatchResponse)),
    protectEmailUnsettledCause,
    Effect.mapError(unknown),
  );

  if (body.data.length > count) {
    return yield* unknown();
  }

  const advertised = yield* Effect.forEach(
    body.data,
    (entry) => Schema.decodeUnknownEffect(ResendBatchAcknowledgement)(entry).pipe(Effect.option),
    { concurrency: 1 },
  );

  const acknowledgements = yield* Effect.forEach(
    body.data,
    (entry) =>
      Schema.decodeUnknownEffect(ResendBatchAcknowledgement, { onExcessProperty: "error" })(
        entry,
      ).pipe(Effect.option),
    { concurrency: 1 },
  );

  const ids = advertised.flatMap((entry) => (Option.isSome(entry) ? [entry.value.id] : []));

  return Object.freeze(
    Array.from({ length: count }, (_, index): ResendBatchEmailResult => {
      const acknowledgement = acknowledgements[index];

      if (acknowledgement === undefined || Option.isNone(acknowledgement)) {
        return Result.fail(unknown());
      }

      const { id } = acknowledgement.value;

      if (ids.filter((candidate) => candidate === id).length !== 1) {
        return Result.fail(unknown());
      }

      return Result.succeed(
        Object.freeze(
          EmailReceiptSchema.cases.Accepted.make({ messageId: id, provider: "resend" }),
        ),
      );
    }),
  );
});

export const resendBatchEmailLayer = (
  options: ResendEmailOptions,
): Layer.Layer<ResendBatchEmail, EmailConfigurationError, HttpClient.HttpClient> =>
  Layer.effect(
    ResendBatchEmail,
    Effect.gen(function* acquireResendBatchEmail() {
      const configuration = yield* Schema.decodeEffect(ResendBatchConfiguration, {
        errors: "all",
        onExcessProperty: "error",
      })(options).pipe(
        Effect.mapError(
          (cause) => new EmailConfigurationError({ issues: emailInputIssues(cause) }),
        ),
      );

      const client = (yield* HttpClient.HttpClient).pipe(HttpClient.withScope);

      const send = Effect.fnUntraced(
        function* sendResendBatch(
          inputs: ResendBatchMessagesInput,
          batchOptions: ResendBatchEmailOptionsInput = {},
        ): Effect.fn.Return<readonly ResendBatchEmailResult[], EmailSendError, Scope.Scope> {
          const messages = yield* Schema.decodeEffect(ResendBatchMessagesSchema, {
            errors: "all",
            onExcessProperty: "error",
          })(inputs).pipe(
            Effect.map((parsed) => Object.freeze(parsed.map(ownEmailMessage))),
            Effect.mapError(
              (cause) => new EmailInvalidMessage({ issues: emailInputIssues(cause) }),
            ),
          );

          const parsedOptions = yield* Schema.decodeEffect(ResendBatchEmailOptionsSchema, {
            errors: "all",
            onExcessProperty: "error",
          })(batchOptions).pipe(
            Effect.mapError(
              (cause) => new EmailInvalidOptions({ issues: emailInputIssues(cause) }),
            ),
          );

          const { idempotencyKey } = parsedOptions;

          const validation = yield* Effect.forEach(
            messages,
            (message) =>
              resendBatchEmailProfile
                .validate(message)
                .pipe(protectEmailUnsettledCause, Effect.result),
            { concurrency: 1 },
          );

          const issues = validation.flatMap((result, index) =>
            Result.isFailure(result)
              ? result.failure.issues.map((issue) => ({ ...issue, path: `${index}.${issue.path}` }))
              : [],
          );

          if (issues.length > 0) {
            return yield* new EmailInvalidMessage({ issues });
          }

          let request = yield* HttpClientRequest.post("https://api.resend.com/emails/batch").pipe(
            HttpClientRequest.bearerToken(Redacted.value(configuration.apiKey)),
            HttpClientRequest.acceptJson,
            HttpClientRequest.setHeader("x-batch-validation", "strict"),
            HttpClientRequest.bodyJson(messages.map(buildResendEmailPayload)),
            Effect.mapError(
              () => new EmailRejected({ provider: "resend", reason: "invalid-message" }),
            ),
          );

          if (idempotencyKey !== undefined) {
            request = HttpClientRequest.setHeader(request, "Idempotency-Key", idempotencyKey);
          }

          const response = yield* client.execute(request).pipe(
            Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
            protectEmailUnsettledCause,
            Effect.mapError(
              () => new EmailDeliveryUnknown({ provider: "resend", reason: "transport" }),
            ),
          );

          if (response.status < 200 || response.status >= 300) {
            return yield* rejectResendBatch(response, idempotencyKey !== undefined);
          }

          return yield* readResendBatchResults(response, messages.length);
        },
        Effect.scoped,
        emailOperationSpan("ResendBatch.send"),
      );

      return ResendBatchEmail.of({ send });
    }),
  );
