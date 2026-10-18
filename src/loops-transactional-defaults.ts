import { Effect, Layer, Schema } from "effect";
import { EmailConfigurationError } from "./email-configuration-error.js";
import { ownEmailDeliveryPolicy } from "./email-delivery-policy.js";
import { emailInputIssues } from "./email-input-issues.js";
import { EmailInvalidMessage } from "./email-invalid-message.js";
import { EmailInvalidOptions } from "./email-invalid-options.js";
import { EmailIdempotencyKeySchema } from "./email-message.js";
import { emailNativeOperations } from "./email-native-operations.js";
import { EmailPolicyOptionsSchema as EmailSendOptionsSchema } from "./email-preparation.js";
import { LoopsTransactionalEmail } from "./loops-transactional-email.js";
import {
  LoopsTransactionalJobSchema,
  ownLoopsDataVariables,
  ownLoopsJob,
} from "./loops-transactional-job.js";
import type { LoopsTransactionalJob } from "./loops-transactional-job.js";

export const LoopsTransactionalDefaultsSchema = Schema.Struct({
  dataVariables: LoopsTransactionalJobSchema.fields.dataVariables,
  idempotencyKeyPrefix: Schema.optionalKey(EmailIdempotencyKeySchema),
});

export type LoopsTransactionalDefaultsInput = typeof LoopsTransactionalDefaultsSchema.Encoded;

export const defaultedLoopsTransactionalLayer = <E, R>(
  loopsLayer: Layer.Layer<LoopsTransactionalEmail, E, R>,
  defaults: LoopsTransactionalDefaultsInput,
): Layer.Layer<LoopsTransactionalEmail, E | EmailConfigurationError, R> =>
  Layer.unwrap(
    Effect.gen(function* configureLoopsTransactionalDefaults() {
      const parsed = yield* Schema.decodeEffect(LoopsTransactionalDefaultsSchema, {
        errors: "all",
        onExcessProperty: "error",
      })(defaults).pipe(
        Effect.mapError(
          (cause) => new EmailConfigurationError({ issues: emailInputIssues(cause) }),
        ),
      );

      const owned = { ...parsed };

      if (parsed.dataVariables !== undefined) {
        owned.dataVariables = ownLoopsDataVariables(parsed.dataVariables);
      }

      Object.freeze(owned);

      return Layer.effect(
        LoopsTransactionalEmail,
        Effect.gen(function* acquireDefaultedLoopsTransactionalEmail() {
          const loops = yield* LoopsTransactionalEmail;

          const prepare = Effect.fnUntraced(function* prepareDefaultedLoopsJob(
            job: LoopsTransactionalJob,
            options: typeof EmailSendOptionsSchema.Type,
          ) {
            const mergedInput = { ...job };

            if (owned.dataVariables !== undefined) {
              mergedInput.dataVariables = { ...owned.dataVariables, ...job.dataVariables };
            }

            const merged = yield* Schema.decodeEffect(LoopsTransactionalJobSchema, {
              errors: "all",
              onExcessProperty: "error",
            })(mergedInput).pipe(
              Effect.mapError(
                (cause) => new EmailInvalidMessage({ issues: emailInputIssues(cause) }),
              ),
            );

            const ownedJob = ownLoopsJob(merged);

            const sendOptions =
              owned.idempotencyKeyPrefix === undefined || options.idempotencyKey === undefined
                ? { ...options }
                : {
                    ...options,
                    idempotencyKey: `${owned.idempotencyKeyPrefix}${options.idempotencyKey}`,
                  };

            if (options.policy !== undefined) {
              sendOptions.policy = ownEmailDeliveryPolicy(options.policy);
            }

            const parsedOptions = yield* Schema.decodeEffect(EmailSendOptionsSchema, {
              errors: "all",
              onExcessProperty: "error",
            })(sendOptions).pipe(
              Effect.mapError(
                (cause) => new EmailInvalidOptions({ issues: emailInputIssues(cause) }),
              ),
            );

            const ownedOptions = Object.freeze(parsedOptions);
            const preview = yield* loops.validate(ownedJob, ownedOptions);

            return Object.freeze({ job: ownedJob, options: ownedOptions, preview });
          });

          const operations = emailNativeOperations({
            jobOf: (prepared) => prepared.preview,
            jobSchema: LoopsTransactionalJobSchema,
            prepare,
            spans: {
              send: "DefaultedLoopsTransactionalEmail.send",
              sendAll: "DefaultedLoopsTransactionalEmail.sendAll",
              validate: "DefaultedLoopsTransactionalEmail.validate",
            },
            submit: (prepared) => loops.send(prepared.job, prepared.options),
          });

          return LoopsTransactionalEmail.of({ ...operations, idempotency: loops.idempotency });
        }),
      ).pipe(Layer.provide(loopsLayer));
    }),
  );
