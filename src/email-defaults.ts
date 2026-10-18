import { Effect, Layer, Schema } from "effect";
import { requireIndividualEmailPreparation } from "./email-composition.js";
import { ownEmailMailbox } from "./email-address.js";
import { emailPreparedOperations } from "./email-prepared-operation.js";
import { EmailConfigurationError } from "./email-configuration-error.js";
import { emailInputIssues } from "./email-input-issues.js";
import { EmailIdempotencyKeySchema, EmailMessageSchema } from "./email-message.js";
import { prepareEmailSubmission, preparedEmailSendOptions } from "./email-preparation.js";
import type { PreparedEmailSubmission } from "./email-preparation.js";
import { Email } from "./email-service.js";

export const EmailDefaultsSchema = Schema.Struct({
  headers: EmailMessageSchema.fields.headers,
  idempotencyKeyPrefix: Schema.optionalKey(EmailIdempotencyKeySchema),
  metadata: EmailMessageSchema.fields.metadata,
  replyTo: EmailMessageSchema.fields.replyTo,
  tags: EmailMessageSchema.fields.tags,
});

export type EmailDefaultsInput = typeof EmailDefaultsSchema.Encoded;

type EmailDefaults = typeof EmailDefaultsSchema.Type;

const ownEmailDefaults = (defaults: EmailDefaults): EmailDefaults => {
  const owned = { ...defaults };

  if (defaults.headers !== undefined) {
    const [first, ...rest] = defaults.headers;
    owned.headers = Object.freeze([
      Object.freeze({ ...first }),
      ...rest.map((header) => Object.freeze({ ...header })),
    ]);
  }

  if (defaults.tags !== undefined) {
    const [first, ...rest] = defaults.tags;
    owned.tags = Object.freeze([
      Object.freeze({ ...first }),
      ...rest.map((tag) => Object.freeze({ ...tag })),
    ]);
  }

  if (defaults.replyTo !== undefined) {
    const [first, ...rest] = defaults.replyTo;
    owned.replyTo = Object.freeze([ownEmailMailbox(first), ...rest.map(ownEmailMailbox)]);
  }

  if (defaults.metadata !== undefined) {
    owned.metadata = Object.freeze({ ...defaults.metadata });
  }

  return Object.freeze(owned);
};

const prepareDefaultedEmail = (prepared: PreparedEmailSubmission, defaults: EmailDefaults) => {
  const message = { ...prepared.submission.message };

  if (defaults.replyTo !== undefined && message.replyTo === undefined) {
    message.replyTo = defaults.replyTo;
  }

  if (defaults.headers !== undefined) {
    message.headers = [...defaults.headers, ...(message.headers ?? [])];
  }

  if (defaults.tags !== undefined) {
    message.tags = [...defaults.tags, ...(message.tags ?? [])];
  }

  if (defaults.metadata !== undefined) {
    message.metadata = { ...defaults.metadata, ...message.metadata };
  }

  const options = preparedEmailSendOptions(prepared);

  const effectiveOptions =
    defaults.idempotencyKeyPrefix === undefined || options.idempotencyKey === undefined
      ? options
      : { ...options, idempotencyKey: `${defaults.idempotencyKeyPrefix}${options.idempotencyKey}` };

  return prepareEmailSubmission(message, effectiveOptions);
};

export const defaultedEmailLayer = <E, R>(
  emailLayer: Layer.Layer<Email, E, R>,
  defaults: EmailDefaultsInput,
): Layer.Layer<Email, E | EmailConfigurationError, R> =>
  Layer.unwrap(
    Effect.gen(function* configureEmailDefaults() {
      const parsed = yield* Schema.decodeEffect(EmailDefaultsSchema, {
        errors: "all",
        onExcessProperty: "error",
      })(defaults).pipe(
        Effect.mapError(
          (cause) => new EmailConfigurationError({ issues: emailInputIssues(cause) }),
        ),
      );

      const owned = ownEmailDefaults(parsed);

      return Layer.effect(
        Email,
        Effect.gen(function* acquireDefaultedEmail() {
          const email = yield* Email;
          yield* requireIndividualEmailPreparation(email.personalization);

          const prepare = Effect.fnUntraced(function* prepareDefaultedOperation(
            prepared: PreparedEmailSubmission,
          ) {
            const merged = yield* prepareDefaultedEmail(prepared, owned);

            return yield* email.prepare(
              merged.submission.message,
              preparedEmailSendOptions(merged),
            );
          });

          return Email.of({
            capabilities: email.capabilities,
            ...emailPreparedOperations(prepare),
          });
        }),
      ).pipe(Layer.provide(emailLayer));
    }),
  );
