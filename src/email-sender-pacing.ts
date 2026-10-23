import { Clock, Duration, Effect, Layer, Option, Ref, Schema, Semaphore } from "effect";
import { EmailConfigurationError } from "./email-configuration-error.js";
import { emailInputIssues } from "./email-input-issues.js";
import { ownEmailMessage } from "./email-message.js";
import { EmailRejected } from "./email-rejected.js";
import { EmailSender } from "./email-sender.js";
import type { IEmailSender } from "./email-sender.js";
import { emailOperationSpan } from "./email-tracing.js";
import { protectEmailUnsettledCause } from "./email-unsettled-cause.js";

const maxEmailPacingSleepNanos = 86_400_000_000_000n;

export const EmailSenderPacingOptionsSchema = Schema.Struct({
  minimumSpacing: Schema.Duration.check(
    Schema.makeFilter(
      (duration) => Duration.isFinite(duration) && Duration.toMillis(duration) > 0,
      { expected: "a positive finite sender admission interval" },
    ),
  ),
});

export type EmailSenderPacingOptionsInput = typeof EmailSenderPacingOptionsSchema.Encoded;

export const pacedEmailSenderLayer = <E, R>(
  senderLayer: Layer.Layer<EmailSender, E, R>,
  options: EmailSenderPacingOptionsInput,
): Layer.Layer<EmailSender, E | EmailConfigurationError, R> =>
  Layer.unwrap(
    Effect.gen(function* configureEmailSenderPacing() {
      const configuration = yield* Schema.decodeEffect(EmailSenderPacingOptionsSchema, {
        errors: "all",
        onExcessProperty: "error",
      })(options).pipe(
        Effect.mapError(
          (cause) => new EmailConfigurationError({ issues: emailInputIssues(cause) }),
        ),
      );

      const intervalNanos = yield* Effect.fromOption(
        Duration.toNanos(configuration.minimumSpacing).pipe(Option.filter((nanos) => nanos > 0n)),
        () =>
          new EmailConfigurationError({
            issues: [
              {
                path: "minimumSpacing",
                problem: "Expected a positive representable nanosecond interval",
              },
            ],
          }),
      );

      return Layer.effect(
        EmailSender,
        Effect.gen(function* acquirePacedEmailSender() {
          const sender = yield* EmailSender;
          const clock = yield* Clock.Clock;
          const admission = yield* Semaphore.make(1);
          const nextAdmission = yield* Ref.make<Option.Option<bigint>>(Option.none());

          const submit: IEmailSender["submit"] = Effect.fnUntraced(function* submitPacedEmail(
            submission,
          ) {
            const owned = Object.freeze({
              ...submission,
              message: ownEmailMessage(submission.message),
            });

            yield* admission.withPermit(
              Effect.gen(function* admitPacedEmail() {
                const next = yield* Ref.get(nextAdmission);

                if (Option.isSome(next)) {
                  let remaining = next.value - (yield* clock.monotonicTimeNanos);

                  while (remaining > 0n) {
                    yield* clock.sleep(
                      Duration.nanos(
                        remaining > maxEmailPacingSleepNanos ? maxEmailPacingSleepNanos : remaining,
                      ),
                    );
                    remaining = next.value - (yield* clock.monotonicTimeNanos);
                  }
                }

                yield* sender.validate(owned.message).pipe(
                  protectEmailUnsettledCause,
                  Effect.mapError(
                    () =>
                      new EmailRejected({ provider: sender.provider, reason: "invalid-message" }),
                  ),
                );
                const admittedAt = yield* clock.monotonicTimeNanos;
                yield* Ref.set(nextAdmission, Option.some(admittedAt + intervalNanos));
              }),
            );

            return yield* sender.submit(owned);
          }, emailOperationSpan("PacedEmailSender.submit"));

          return EmailSender.of({
            capabilities: sender.capabilities,
            idempotency: sender.idempotency,
            provider: sender.provider,
            submit,
            validate: (message) => sender.validate(message),
          });
        }),
      ).pipe(Layer.provide(senderLayer));
    }),
  );
