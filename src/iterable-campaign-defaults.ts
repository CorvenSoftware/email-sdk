import { Effect, Layer, Schema } from "effect";
import { EmailConfigurationError } from "./email-configuration-error.js";
import { ownEmailDeliveryPolicy } from "./email-delivery-policy.js";
import { emailInputIssues } from "./email-input-issues.js";
import { EmailInvalidMessage } from "./email-invalid-message.js";
import { emailNativeOperations } from "./email-native-operations.js";
import type { EmailPolicyOptionsSchema as EmailSendOptionsSchema } from "./email-preparation.js";
import { IterableCampaignEmail } from "./iterable-campaign-email.js";
import {
  IterableCampaignJobSchema,
  ownIterableDataFields,
  ownIterableJob,
} from "./iterable-campaign-job.js";
import type { IterableCampaignJob } from "./iterable-campaign-job.js";

export const IterableCampaignDefaultsSchema = Schema.Struct({
  dataFields: IterableCampaignJobSchema.fields.dataFields,
  metadata: IterableCampaignJobSchema.fields.metadata,
});

export type IterableCampaignDefaultsInput = typeof IterableCampaignDefaultsSchema.Encoded;

export const defaultedIterableCampaignLayer = <E, R>(
  iterableLayer: Layer.Layer<IterableCampaignEmail, E, R>,
  defaults: IterableCampaignDefaultsInput,
): Layer.Layer<IterableCampaignEmail, E | EmailConfigurationError, R> =>
  Layer.unwrap(
    Effect.gen(function* configureIterableCampaignDefaults() {
      const parsed = yield* Schema.decodeEffect(IterableCampaignDefaultsSchema, {
        errors: "all",
        onExcessProperty: "error",
      })(defaults).pipe(
        Effect.mapError(
          (cause) => new EmailConfigurationError({ issues: emailInputIssues(cause) }),
        ),
      );

      const owned = { ...parsed };

      if (parsed.dataFields !== undefined) {
        owned.dataFields = ownIterableDataFields(parsed.dataFields);
      }

      if (parsed.metadata !== undefined) {
        owned.metadata = Object.freeze({ ...parsed.metadata });
      }

      Object.freeze(owned);

      return Layer.effect(
        IterableCampaignEmail,
        Effect.gen(function* acquireDefaultedIterableCampaignEmail() {
          const iterable = yield* IterableCampaignEmail;

          const prepare = Effect.fnUntraced(function* prepareDefaultedIterableJob(
            job: IterableCampaignJob,
            options: typeof EmailSendOptionsSchema.Type,
          ) {
            const mergedInput = { ...job };

            if (owned.dataFields !== undefined) {
              mergedInput.dataFields = { ...owned.dataFields, ...job.dataFields };
            }

            if (owned.metadata !== undefined) {
              mergedInput.metadata = { ...owned.metadata, ...job.metadata };
            }

            const merged = yield* Schema.decodeEffect(IterableCampaignJobSchema, {
              errors: "all",
              onExcessProperty: "error",
            })(mergedInput).pipe(
              Effect.mapError(
                (cause) => new EmailInvalidMessage({ issues: emailInputIssues(cause) }),
              ),
            );

            const ownedJob = ownIterableJob(merged);
            const sendOptions = { ...options };

            if (options.policy !== undefined) {
              sendOptions.policy = ownEmailDeliveryPolicy(options.policy);
            }

            const ownedOptions = Object.freeze(sendOptions);
            const preview = yield* iterable.validate(ownedJob, ownedOptions);

            return Object.freeze({ job: ownedJob, options: ownedOptions, preview });
          });

          const operations = emailNativeOperations({
            jobOf: (prepared) => prepared.preview,
            jobSchema: IterableCampaignJobSchema,
            prepare,
            spans: {
              send: "DefaultedIterableCampaignEmail.send",
              sendAll: "DefaultedIterableCampaignEmail.sendAll",
              validate: "DefaultedIterableCampaignEmail.validate",
            },
            submit: (prepared) => iterable.send(prepared.job, prepared.options),
          });

          return IterableCampaignEmail.of({ ...operations, idempotency: iterable.idempotency });
        }),
      ).pipe(Layer.provide(iterableLayer));
    }),
  );
