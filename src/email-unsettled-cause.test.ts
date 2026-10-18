import { assert, describe, it } from "@effect/vitest";
import { Cause, Deferred, Duration, Effect, Exit, Fiber, Layer, Ref, Schema } from "effect";
import { TestClock } from "effect/testing";
import { validateEmailCapabilities } from "./email-capabilities.js";
import type { EmailConfigurationError } from "./email-configuration-error.js";
import { EmailDeliveryUnknown } from "./email-delivery-unknown.js";
import type { EmailSubmissionError, EmailSendError } from "./email-errors.js";
import { EmailReceiptSchema } from "./email-message.js";
import { EmailRejected } from "./email-rejected.js";
import { emailRouterLayer } from "./email-routing.js";
import { EmailSender, EmailSenderIdempotencySchema } from "./email-sender.js";
import type { IEmailSender } from "./email-sender.js";
import { Email, emailLayer } from "./email-service.js";
import { observedEmailSenderLayer } from "./email-submission-observations.js";
import { recordingEmailCapabilities } from "./recording-email-sender.js";

const policy = { deadline: Duration.seconds(10), initialDelay: Duration.millis(1), maxAttempts: 3 };

const message = {
  body: { text: "Synthetic" },
  from: "sender@fictional.invalid",
  subject: "Fictional",
  to: "recipient@fictional.invalid",
};

const authority = EmailSenderIdempotencySchema.cases.Native.make({ retention: Duration.hours(24) });

const suppliedSender = (submit: IEmailSender["submit"]) =>
  Layer.succeed(
    EmailSender,
    EmailSender.of({
      capabilities: recordingEmailCapabilities,
      idempotency: authority,
      provider: "fixture",
      submit,
      validate: (input) => validateEmailCapabilities(input, recordingEmailCapabilities),
    }),
  );

const variants = Schema.Struct({
  interruption: Schema.Literals(["Defect", "Interrupt", "AnotherFailure"]),
  observed: Schema.Boolean,
  reversed: Schema.Boolean,
  uncertainty: Schema.Boolean,
});

describe("unsettled compound email failures", () => {
  for (const mode of ["Direct", "Batch", "Personalized", "Routed"] as const) {
    it.effect.prop(
      `preserves compound evidence without retry, fallback or settlement in ${mode}`,
      { variant: variants },
      ({ variant }) =>
        Effect.gen(function* preserveUnsettledEmailEvidence() {
          const entered = yield* Deferred.make<boolean>();
          const calls = yield* Ref.make(0);
          const backups = yield* Ref.make(0);
          const callbacks = yield* Ref.make(0);

          const failure: EmailSubmissionError = variant.uncertainty
            ? new EmailDeliveryUnknown({ provider: "fixture", reason: "transport" })
            : new EmailRejected({ provider: "fixture", reason: "rate-limited" });

          const defect = new Error("private compound email defect");

          const secondary = {
            AnotherFailure: Cause.fail(
              new EmailRejected({ provider: "fixture", reason: "temporarily-unavailable" }),
            ),
            Defect: Cause.die(defect),
            Interrupt: Cause.interrupt(123),
          }[variant.interruption];

          const cause = variant.reversed
            ? Cause.combine(secondary, Cause.fail(failure))
            : Cause.combine(Cause.fail(failure), secondary);

          const base = suppliedSender(() =>
            Ref.update(calls, (count) => count + 1).pipe(
              Effect.andThen(Deferred.succeed(entered, true)),
              Effect.andThen(Effect.failCause(cause)),
            ),
          );

          const sender: Layer.Layer<EmailSender, EmailConfigurationError> = variant.observed
            ? observedEmailSenderLayer(base, {}, () => Ref.update(callbacks, (count) => count + 1))
            : base;

          const primary = emailLayer(policy).pipe(Layer.provideMerge(sender));

          const backup = emailLayer(policy).pipe(
            Layer.provide(
              suppliedSender(() =>
                Ref.update(backups, (count) => count + 1).pipe(
                  Effect.as(EmailReceiptSchema.cases.Accepted.make({ provider: "backup" })),
                ),
              ),
            ),
          );

          const app = Effect.gen(function* inspectCompoundEmailOutcome() {
            const email = yield* Email;

            const operation: () => Effect.Effect<unknown, EmailSendError> = {
              Batch: () => email.sendAll([{ message, options: { idempotencyKey: "owned-key" } }]),
              Direct: () => email.send(message, { idempotencyKey: "owned-key" }),
              Personalized: () =>
                email.sendPersonalized({
                  message: {
                    body: { text: "%recipient.name%" },
                    from: message.from,
                    subject: message.subject,
                  },
                  recipients: [
                    {
                      idempotencyKey: "owned-key",
                      to: message.to,
                      variables: { name: "Synthetic" },
                    },
                  ],
                }),
              Routed: () => email.send(message, { idempotencyKey: "owned-key" }),
            }[mode];

            const fiber = yield* operation().pipe(Effect.exit, Effect.forkScoped);
            yield* Deferred.await(entered);
            yield* TestClock.adjust("5 seconds");
            const exit = yield* Fiber.join(fiber);
            assert(Exit.isFailure(exit));
            assert(Exit.hasDies(exit));

            const retained = exit.cause.reasons
              .filter(Cause.isDieReason)
              .map((reason) => reason.defect)
              .find(Cause.isCause);

            assert(Cause.isCause(retained));
            assert(
              retained.reasons
                .filter(Cause.isFailReason)
                .some((reason) => reason.error === failure),
            );
            assert.deepStrictEqual(
              retained.reasons.map((reason) => reason._tag),
              cause.reasons.map((reason) => reason._tag),
            );
            assert.deepStrictEqual(
              retained.reasons.filter(Cause.isFailReason).map((reason) => reason.error),
              cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error),
            );

            if (variant.interruption === "Defect") {
              assert(
                exit.cause.reasons
                  .filter(Cause.isDieReason)
                  .some((reason) => reason.defect === defect),
              );
            }

            if (variant.interruption === "Interrupt") {
              assert(Exit.hasInterrupts(exit));
            }

            assert.strictEqual(yield* Ref.get(calls), 1);
            assert.strictEqual(yield* Ref.get(backups), 0);
            assert.strictEqual(yield* Ref.get(callbacks), 0);
          });

          const selected: Layer.Layer<Email, EmailConfigurationError> =
            mode === "Routed"
              ? emailRouterLayer(
                  [
                    { layer: primary, name: "primary" },
                    { layer: backup, name: "backup" },
                  ],
                  { fallbacks: ["backup"], primary: "primary" },
                )
              : primary;

          yield* app.pipe(Effect.provide(selected));
        }),
      { arbitrary: { runs: 12 } },
    );
  }
});
