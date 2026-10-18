import { Effect, Match, Schema, Struct, UndefinedOr } from "effect";
import type { EmailSendError } from "./email-errors.js";
import { EmailDeliveryPolicySchema, ownEmailDeliveryPolicy } from "./email-delivery-policy.js";
import type { EmailDeliveryPolicy } from "./email-delivery-policy.js";
import { protectEmailUnsettledCause } from "./email-unsettled-cause.js";
import { emailInputIssues } from "./email-input-issues.js";
import { EmailInvalidMessage } from "./email-invalid-message.js";
import { EmailInvalidOptions } from "./email-invalid-options.js";
import {
  EmailIdempotencyKeySchema,
  EmailMessageSchema,
  ownEmailMessage,
  parseEmailMessage,
} from "./email-message.js";
import type { EmailMessage, EmailMessageInput } from "./email-message.js";
import type { EmailSubmission } from "./email-sender.js";
import {
  EmailExecutionMetadataSchema,
  ownEmailExecutionMetadata,
} from "./email-execution-metadata.js";
import type { EmailExecutionMetadata } from "./email-execution-metadata.js";

export {
  EmailExecutionMetadataSchema,
  ownEmailExecutionMetadata,
} from "./email-execution-metadata.js";

export type {
  EmailExecutionMetadata,
  EmailExecutionMetadataInput,
  EmailExecutionMetadataValue,
  EmailExecutionMetadataInputValue,
} from "./email-execution-metadata.js";

export const EmailPolicyOptionsSchema = Schema.Struct({
  idempotencyKey: Schema.optionalKey(EmailIdempotencyKeySchema),
  policy: Schema.optionalKey(EmailDeliveryPolicySchema),
});

export type EmailPolicyOptionsInput = typeof EmailPolicyOptionsSchema.Encoded;

export const EmailSendOptionsSchema = EmailPolicyOptionsSchema.mapFields((fields) => ({
  ...fields,
  executionMetadata: Schema.optionalKey(EmailExecutionMetadataSchema),
}));

export type EmailSendOptionsInput = typeof EmailSendOptionsSchema.Encoded;

export type EmailSendOptions = typeof EmailSendOptionsSchema.Type;

export const EmailSendRequestSchema = Schema.Struct({
  message: EmailMessageSchema,
  options: Schema.optionalKey(EmailSendOptionsSchema),
});

export type EmailSendRequest = typeof EmailSendRequestSchema.Encoded;

export const EmailBatchOptionsSchema = Schema.Struct({
  concurrency: Schema.Int.check(Schema.isBetween({ maximum: 32, minimum: 1 })),
});

export type EmailBatchOptionsInput = typeof EmailBatchOptionsSchema.Encoded;

export const EmailPersonalizedOptionsSchema = EmailBatchOptionsSchema.mapFields((fields) => ({
  concurrency: Schema.optionalKey(fields.concurrency),
  executionMetadata: EmailSendOptionsSchema.fields.executionMetadata,
}));

export type EmailPersonalizedOptionsInput = typeof EmailPersonalizedOptionsSchema.Encoded;

export interface PreparedEmailSubmission {
  readonly submission: EmailSubmission;
  readonly policy?: EmailDeliveryPolicy;
  readonly executionMetadata?: EmailExecutionMetadata;
}

export const preparedEmailSendOptions = (prepared: PreparedEmailSubmission): EmailSendOptions =>
  Object.freeze({
    ...Struct.omit(prepared.submission, ["message"]),
    ...UndefinedOr.match(prepared.policy, {
      onDefined: (policy) => ({ policy }),
      onUndefined: () => ({}),
    }),
    ...UndefinedOr.match(prepared.executionMetadata, {
      onDefined: (executionMetadata) => ({ executionMetadata }),
      onUndefined: () => ({}),
    }),
  });

const parseSendOptions = Schema.decodeUnknownEffect(EmailSendOptionsSchema, {
  errors: "all",
  onExcessProperty: "error",
});

const parseSendRequest = Schema.decodeUnknownEffect(EmailSendRequestSchema, {
  errors: "all",
  onExcessProperty: "error",
});

const decodeBatchOptions = Schema.decodeUnknownEffect(EmailBatchOptionsSchema, {
  errors: "all",
  onExcessProperty: "error",
});

export const ownEmailSendOptions = (options: EmailSendOptions): EmailSendOptions =>
  Object.freeze({
    ...Struct.omit(options, ["policy", "executionMetadata"]),
    ...UndefinedOr.match(options.policy, {
      onDefined: (policy) => ({ policy: ownEmailDeliveryPolicy(policy) }),
      onUndefined: () => ({}),
    }),
    ...UndefinedOr.match(options.executionMetadata, {
      onDefined: (metadata) => ({ executionMetadata: ownEmailExecutionMetadata(metadata) }),
      onUndefined: () => ({}),
    }),
  });

const ownPreparedEmailSubmission = (
  message: EmailMessage,
  options: EmailSendOptions,
): PreparedEmailSubmission => {
  const owned = ownEmailSendOptions(options);

  return Object.freeze({
    ...Struct.pick(owned, ["policy", "executionMetadata"]),
    submission: Object.freeze({ message, ...Struct.omit(owned, ["policy", "executionMetadata"]) }),
  });
};

export const prepareEmailSubmission = Effect.fnUntraced(function* prepareEmailSubmission(
  message: EmailMessageInput,
  options: EmailSendOptionsInput = {},
): Effect.fn.Return<PreparedEmailSubmission, EmailInvalidMessage | EmailInvalidOptions> {
  const preparedMessage = yield* parseEmailMessage(message);

  const preparedOptions = yield* parseSendOptions(options).pipe(
    Effect.mapError((cause) => new EmailInvalidOptions({ issues: emailInputIssues(cause) })),
  );

  return ownPreparedEmailSubmission(preparedMessage, preparedOptions);
});

export const prepareEmailSendRequest = Effect.fnUntraced(function* prepareEmailSendRequest(
  request: EmailSendRequest,
): Effect.fn.Return<PreparedEmailSubmission, EmailInvalidMessage | EmailInvalidOptions> {
  const parsed = yield* parseSendRequest(request).pipe(
    Effect.mapError((cause) => {
      const issues = emailInputIssues(cause);

      return issues.some((issue) => issue.path === "message" || issue.path.startsWith("message."))
        ? new EmailInvalidMessage({ issues })
        : new EmailInvalidOptions({ issues });
    }),
  );

  return ownPreparedEmailSubmission(ownEmailMessage(parsed.message), parsed.options ?? {});
});

const defaultBatchOptions: EmailBatchOptionsInput = { concurrency: 4 };

export const parseEmailBatchOptions = (options: EmailBatchOptionsInput = defaultBatchOptions) =>
  decodeBatchOptions(options).pipe(
    Effect.mapError((cause) => new EmailInvalidOptions({ issues: emailInputIssues(cause) })),
  );

export const parseEmailPersonalizedOptions = (options: EmailPersonalizedOptionsInput = {}) =>
  Schema.decodeEffect(EmailPersonalizedOptionsSchema, { errors: "all", onExcessProperty: "error" })(
    options,
  ).pipe(
    Effect.mapError((cause) => new EmailInvalidOptions({ issues: emailInputIssues(cause) })),
    Effect.map((parsed) =>
      Object.freeze({
        concurrency: parsed.concurrency ?? defaultBatchOptions.concurrency,
        ...UndefinedOr.match(parsed.executionMetadata, {
          onDefined: (metadata) => ({ executionMetadata: ownEmailExecutionMetadata(metadata) }),
          onUndefined: () => ({}),
        }),
      }),
    ),
  );

export const qualifyEmailRequestFailure = <A>(
  effect: Effect.Effect<A, EmailSendError>,
  messageField: "message" | "job" = "message",
) =>
  effect.pipe(
    protectEmailUnsettledCause,
    Effect.mapError((failure) =>
      Match.value(failure).pipe(
        Match.tag(
          "EmailInvalidMessage",
          (invalid) =>
            new EmailInvalidMessage({
              issues: invalid.issues.map((issue) => ({
                ...issue,
                path: issue.path === "<root>" ? messageField : `${messageField}.${issue.path}`,
              })),
            }),
        ),
        Match.tag(
          "EmailInvalidOptions",
          (invalid) =>
            new EmailInvalidOptions({
              issues: invalid.issues.map((issue) => ({
                ...issue,
                path: `options.${issue.path}`,
              })),
            }),
        ),
        Match.orElse((unchanged) => unchanged),
      ),
    ),
  );
