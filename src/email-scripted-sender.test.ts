import { assert, describe, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Queue, Result } from "effect";
import { makeScriptedEmailSender } from "../test/email-scripted-sender-fixture.js";
import { startEmailTraceFixture } from "../test/email-tracing-fixture.js";
import {
  Email,
  EmailDeliveryUnknown,
  EmailReceiptSchema,
  EmailSenderIdempotencySchema,
  emailLayer,
} from "./index.js";

const message = {
  body: { text: "private scripted body" },
  from: "sender@fictional.invalid",
  subject: "private scripted subject",
  to: "recipient@fictional.invalid",
};

const firstReceipt = EmailReceiptSchema.cases.Recorded.make({ sequence: 1 });

const secondReceipt = EmailReceiptSchema.cases.Recorded.make({ sequence: 2 });

const keyForwarding = EmailSenderIdempotencySchema.cases.KeyForwarding.make({});

describe("scripted email sender fixture", () => {
  it.effect("owns its outcome sequence and does not deduplicate repeated keys", () =>
    Effect.gen(function* runScriptedEmailOutcomes() {
      const outcomes = [Effect.succeed(firstReceipt), Effect.succeed(secondReceipt)];
      const fixture = yield* makeScriptedEmailSender(outcomes, { idempotency: keyForwarding });
      outcomes[1] = Effect.die(new Error("private replacement outcome"));

      yield* Effect.gen(function* submitScriptedEmails() {
        const email = yield* Email;
        const options = { idempotencyKey: "private-scripted-key" };
        assert.strictEqual(yield* email.send(message, options), firstReceipt);
        assert.strictEqual(yield* email.send(message, options), secondReceipt);
      }).pipe(Effect.provide(emailLayer().pipe(Layer.provide(fixture.layer))));

      const attempts = yield* fixture.attempts;
      assert.deepStrictEqual(
        attempts.map((attempt) => [attempt.message.subject, attempt.idempotencyKey]),
        [
          ["private scripted subject", "private-scripted-key"],
          ["private scripted subject", "private-scripted-key"],
        ],
      );
      assert.isFrozen(attempts);
      const [first] = attempts;
      assert.isDefined(first);
      assert.isFrozen(first);
      assert.isFrozen(first.message);
      assert.isFrozen(first.message.body);
    }),
  );

  it.effect.each(["Default", "KeyForwarding"] as const)(
    "does not infer unknown replay authority from %s",
    (authority) =>
      Effect.gen(function* stopUnauthorizedScriptedReplay() {
        const unknown = new EmailDeliveryUnknown({ provider: "scripted", reason: "transport" });

        const fixture = yield* makeScriptedEmailSender(
          [Effect.fail(unknown), Effect.succeed(secondReceipt)],
          authority === "Default" ? {} : { idempotency: keyForwarding },
        );

        yield* Effect.gen(function* submitUnknownScriptedEmail() {
          const email = yield* Email;

          const options =
            authority === "Default" ? undefined : { idempotencyKey: "private-scripted-key" };

          const result = yield* email.send(message, options).pipe(Effect.result);
          assert(Result.isFailure(result));
          assert.strictEqual(result.failure, unknown);
          assert.strictEqual((yield* fixture.attempts).length, 1);
          assert.strictEqual(yield* email.send(message, options), secondReceipt);
          assert.strictEqual((yield* fixture.attempts).length, 2);
        }).pipe(Effect.provide(emailLayer().pipe(Layer.provide(fixture.layer))));
      }),
  );

  it.effect("allocates concurrent script slots before gated outcomes complete", () =>
    Effect.gen(function* allocateConcurrentScriptedEmails() {
      const release = yield* Deferred.make<true>();

      const fixture = yield* makeScriptedEmailSender(
        [1, 2, 3, 4].map((sequence) =>
          Deferred.await(release).pipe(
            Effect.as(EmailReceiptSchema.cases.Recorded.make({ sequence })),
          ),
        ),
      );

      const fiber = yield* Effect.gen(function* submitConcurrentScriptedEmails() {
        const email = yield* Email;

        return yield* email.sendAll(
          ["first", "second", "third", "fourth"].map((subject) => ({
            message: { ...message, subject },
          })),
          { concurrency: 4 },
        );
      }).pipe(Effect.provide(emailLayer().pipe(Layer.provide(fixture.layer))), Effect.forkScoped);

      const entered = yield* Effect.forEach([1, 2, 3, 4], () => Queue.take(fixture.submissions));
      assert.deepStrictEqual(entered.map((submission) => submission.message.subject).toSorted(), [
        "first",
        "fourth",
        "second",
        "third",
      ]);
      const pending = yield* fixture.attempts;
      assert.strictEqual(pending.length, 4);
      yield* Deferred.succeed(release, true);
      const results = yield* Fiber.join(fiber);

      const sequences = results.map((result) => {
        assert(Result.isSuccess(result));
        assert(EmailReceiptSchema.guards.Recorded(result.success));

        return result.success.sequence;
      });

      assert.deepStrictEqual(
        sequences.toSorted((left, right) => left - right),
        [1, 2, 3, 4],
      );
      assert.deepStrictEqual(yield* fixture.attempts, pending);
    }),
  );

  it.effect("cancels a Deferred-gated outcome without replaying or resetting its slot", () =>
    Effect.gen(function* cancelGatedScriptedEmail() {
      const entered = yield* Deferred.make<true>();
      const release = yield* Deferred.make<true>();
      const finalized = yield* Deferred.make<true>();

      const fixture = yield* makeScriptedEmailSender([
        Deferred.succeed(entered, true).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(firstReceipt),
          Effect.ensuring(Deferred.succeed(finalized, true)),
        ),
        Effect.succeed(secondReceipt),
      ]);

      yield* Effect.gen(function* submitCancellableScriptedEmail() {
        const email = yield* Email;
        const fiber = yield* email.send(message).pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        const pending = yield* fixture.attempts;
        assert.strictEqual(pending.length, 1);
        assert.strictEqual(pending[0]?.message.subject, "private scripted subject");
        yield* Fiber.interrupt(fiber);
        yield* Deferred.await(finalized);
        assert(Exit.hasInterrupts(yield* Fiber.await(fiber)));
        assert.strictEqual(yield* email.send(message), secondReceipt);
        assert.strictEqual((yield* fixture.attempts).length, 2);
        assert.strictEqual(pending.length, 1);
      }).pipe(Effect.provide(emailLayer().pipe(Layer.provide(fixture.layer))));
    }),
  );

  it.effect.each(["Defect", "Interruption"] as const)(
    "propagates %s without ordinary batch settlement or a retry",
    (fault) =>
      Effect.gen(function* preserveScriptedEmailCause() {
        const defect = new Error("private scripted defect");

        const fixture = yield* makeScriptedEmailSender([
          fault === "Defect" ? Effect.die(defect) : Effect.failCause(Cause.interrupt(123)),
          Effect.succeed(secondReceipt),
        ]);

        yield* Effect.gen(function* submitUnsettledScriptedEmail() {
          const email = yield* Email;
          const outcome = yield* email.sendAll([{ message }]).pipe(Effect.exit);
          assert(Exit.isFailure(outcome));
          assert.strictEqual((yield* fixture.attempts).length, 1);

          if (fault === "Defect") {
            assert.isTrue(
              outcome.cause.reasons.some(
                (reason) => Cause.isDieReason(reason) && reason.defect === defect,
              ),
            );
          } else {
            assert.isTrue(Exit.hasInterrupts(outcome));
          }

          assert.strictEqual(yield* email.send(message), secondReceipt);
          assert.strictEqual((yield* fixture.attempts).length, 2);
        }).pipe(Effect.provide(emailLayer().pipe(Layer.provide(fixture.layer))));
      }),
  );

  it.effect("defects loudly on exhaustion without private diagnostics", () =>
    Effect.gen(function* exhaustScriptedEmailOutcomes() {
      const trace = yield* startEmailTraceFixture();
      const fixture = yield* makeScriptedEmailSender([], { idempotency: keyForwarding });

      const outcome = yield* Effect.gen(function* submitExhaustedScriptedEmail() {
        return yield* (yield* Email).send(message, { idempotencyKey: "private-scripted-key" });
      }).pipe(
        Effect.provide(emailLayer().pipe(Layer.provide(fixture.layer))),
        Effect.withTracer(trace.tracer),
        Effect.exit,
      );

      assert(Exit.isFailure(outcome));

      const [defect] = outcome.cause.reasons
        .filter(Cause.isDieReason)
        .map((reason) => reason.defect);

      assert(defect instanceof Error);
      assert.strictEqual(defect.message, "ScriptedEmailSender exhausted its outcome sequence");
      assert.strictEqual((yield* fixture.attempts).length, 1);
      const diagnostics = yield* trace.diagnostics;
      assert.include(diagnostics, "Email.send");

      for (const privateValue of [
        "private scripted body",
        "private scripted subject",
        "private-scripted-key",
        "sender@fictional.invalid",
        "recipient@fictional.invalid",
      ]) {
        assert.notInclude(defect.message, privateValue);
        assert.notInclude(diagnostics, privateValue);
      }
    }),
  );
});
