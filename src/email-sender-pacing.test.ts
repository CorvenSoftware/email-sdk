import { assert, describe, it } from "@effect/vitest";
import {
  Cause,
  Clock,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Queue,
  Ref,
  Result,
} from "effect";
import { TestClock } from "effect/testing";
import { EmailConfigurationError } from "./email-configuration-error.js";
import { EmailDeliveryUnknown } from "./email-delivery-unknown.js";
import { EmailInvalidMessage } from "./email-invalid-message.js";
import { EmailReceiptSchema, parseEmailMessage } from "./email-message.js";
import { EmailRejected } from "./email-rejected.js";
import { EmailSender, EmailSenderIdempotencySchema } from "./email-sender.js";
import type { IEmailSender } from "./email-sender.js";
import { pacedEmailSenderLayer } from "./email-sender-pacing.js";
import { Email, emailLayer } from "./email-service.js";
import { recordingEmailCapabilities, recordingSenderLayer } from "./recording-email-sender.js";

const message = {
  body: { text: "Fictional paced notification." },
  from: "sender@example.test",
  subject: "Paced notification",
  to: "recipient@example.test",
};

const receipt = EmailReceiptSchema.cases.Recorded.make({ sequence: 1 });

const pacingLayer = (
  submit: IEmailSender["submit"],
  validate: IEmailSender["validate"] = () => Effect.void,
) =>
  pacedEmailSenderLayer(
    Layer.succeed(
      EmailSender,
      EmailSender.of({
        capabilities: recordingEmailCapabilities,
        idempotency: EmailSenderIdempotencySchema.cases.None.make({}),
        provider: "paced-fixture",
        submit,
        validate,
      }),
    ),
    { minimumSpacing: Duration.millis(100) },
  );

const policy = {
  deadline: Duration.seconds(1),
  initialDelay: Duration.millis(1),
  maxAttempts: 1,
};

describe("Email sender admission pacing", () => {
  it.effect("spaces shared admissions without waiting for previous submissions to finish", () =>
    Effect.gen(function* spaceConcurrentAdmissions() {
      const started = yield* Queue.unbounded<bigint>();
      const finish = yield* Deferred.make<true>();

      const layer = pacingLayer(() =>
        Effect.gen(function* awaitPacedAcknowledgement() {
          yield* Queue.offer(started, yield* Clock.monotonicTimeNanos);
          yield* Deferred.await(finish);

          return receipt;
        }),
      );

      yield* Effect.gen(function* submitOverlappingPacedEmails() {
        const sender = yield* EmailSender;
        const email = yield* Email;
        assert.strictEqual(sender.provider, "paced-fixture");
        const first = yield* email.send(message).pipe(Effect.forkScoped);
        assert.strictEqual(yield* Queue.take(started), 0n);
        const second = yield* email.send(message).pipe(Effect.forkScoped);
        yield* TestClock.adjust(99);
        assert.strictEqual(yield* Queue.size(started), 0);
        yield* TestClock.adjust(1);
        assert.strictEqual(yield* Queue.take(started), 100_000_000n);
        yield* Deferred.succeed(finish, true);
        assert.strictEqual(yield* Fiber.join(first), receipt);
        assert.strictEqual(yield* Fiber.join(second), receipt);
      }).pipe(Effect.provide(emailLayer(policy).pipe(Layer.provideMerge(layer))));
    }),
  );

  it.effect("does not reserve a future admission for an interrupted waiter", () =>
    Effect.gen(function* releaseCancelledAdmission() {
      const started = yield* Queue.unbounded<bigint>();

      const layer = pacingLayer(() => Queue.offer(started, 0n).pipe(Effect.as(receipt)));

      yield* Effect.gen(function* interruptPacedWaiter() {
        const email = yield* Email;
        yield* email.send(message);
        yield* Queue.take(started);
        const waiting = yield* email.send(message).pipe(Effect.forkScoped);
        yield* TestClock.adjust(25);
        yield* Fiber.interrupt(waiting);
        assert(Exit.hasInterrupts(yield* Fiber.await(waiting)));
        const next = yield* email.send(message).pipe(Effect.forkScoped);
        yield* TestClock.adjust(75);
        assert.strictEqual(yield* Fiber.join(next), receipt);
        assert.strictEqual(yield* Queue.size(started), 1);
      }).pipe(Effect.provide(emailLayer(policy).pipe(Layer.provide(layer))));
    }),
  );

  it.effect("charges each eligible retry without adding another retry owner", () =>
    Effect.gen(function* paceEligibleRetry() {
      const attempts = yield* Queue.unbounded<bigint>();
      const remainingFailures = yield* Ref.make(1);

      const layer = pacingLayer(() =>
        Effect.gen(function* rejectFirstPacedAttempt() {
          yield* Queue.offer(attempts, yield* Clock.monotonicTimeNanos);

          if ((yield* Ref.getAndUpdate(remainingFailures, (remaining) => remaining - 1)) > 0) {
            return yield* new EmailRejected({ provider: "paced-fixture", reason: "rate-limited" });
          }

          return receipt;
        }),
      );

      const sending = yield* Email.use((email) => email.send(message)).pipe(
        Effect.provide(emailLayer({ ...policy, maxAttempts: 2 }).pipe(Layer.provide(layer))),
        Effect.forkScoped,
      );

      assert.strictEqual(yield* Queue.take(attempts), 0n);
      yield* TestClock.adjust(100);
      assert.strictEqual(yield* Queue.take(attempts), 100_000_000n);
      assert.strictEqual(yield* Fiber.join(sending), receipt);
      assert.strictEqual(yield* Queue.size(attempts), 0);
    }),
  );

  it.effect("revalidates expired intent after waiting without invoking the sender", () =>
    Effect.gen(function* recheckPacedIntent() {
      const attempts = yield* Queue.unbounded<string>();

      const layer = pacingLayer(
        () => Queue.offer(attempts, "submitted").pipe(Effect.as(receipt)),
        () =>
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((now) =>
              now < 100
                ? Effect.void
                : Effect.fail(
                    new EmailInvalidMessage({ issues: [{ path: "sendAt", problem: "Expired" }] }),
                  ),
            ),
          ),
      );

      yield* Effect.gen(function* expireWaitingEmail() {
        const email = yield* Email;
        yield* email.send(message);
        const waiting = yield* email.send(message).pipe(Effect.result, Effect.forkScoped);
        yield* TestClock.adjust(100);
        const result = yield* Fiber.join(waiting);
        assert(Result.isFailure(result));
        assert(result.failure instanceof EmailRejected);
        assert.strictEqual(result.failure.reason, "invalid-message");
        assert.strictEqual(yield* Queue.size(attempts), 1);
      }).pipe(Effect.provide(emailLayer(policy).pipe(Layer.provide(layer))));
    }),
  );

  it.effect("keeps waiting inside the existing deadline and never submits timed-out work", () =>
    Effect.gen(function* enforcePacingDeadline() {
      const attempts = yield* Queue.unbounded<string>();
      const layer = pacingLayer(() => Queue.offer(attempts, "submitted").pipe(Effect.as(receipt)));
      yield* Effect.gen(function* timeoutWaitingEmail() {
        const email = yield* Email;
        yield* email.send(message);
        const waiting = yield* email.send(message).pipe(Effect.result, Effect.forkScoped);
        yield* TestClock.adjust(50);
        const result = yield* Fiber.join(waiting);
        assert(Result.isFailure(result));
        assert(result.failure instanceof EmailDeliveryUnknown);
        assert.strictEqual(result.failure.reason, "timeout");
        yield* TestClock.adjust(100);
        assert.strictEqual(yield* Queue.size(attempts), 1);
      }).pipe(
        Effect.provide(
          emailLayer({ ...policy, deadline: Duration.millis(50) }).pipe(Layer.provide(layer)),
        ),
      );
    }),
  );

  it.effect("keeps separate acquired accounts independent", () =>
    Effect.gen(function* isolateAccountPacing() {
      const admissions = yield* Queue.unbounded<bigint>();

      const submit = () =>
        Clock.monotonicTimeNanos.pipe(
          Effect.flatMap((now) => Queue.offer(admissions, now)),
          Effect.as(receipt),
        );

      const first = emailLayer(policy).pipe(Layer.provide(pacingLayer(submit)));
      const second = emailLayer(policy).pipe(Layer.provide(pacingLayer(submit)));
      yield* Email.use((email) => email.send(message)).pipe(Effect.provide(first));
      yield* Email.use((email) => email.send(message)).pipe(Effect.provide(second));
      assert.strictEqual(yield* Queue.take(admissions), 0n);
      assert.strictEqual(yield* Queue.take(admissions), 0n);
    }),
  );

  it.effect(
    "preserves compound validation defects instead of returning an ordinary rejection",
    () =>
      Effect.gen(function* preservePacingDefects() {
        const validation = yield* Ref.make(0);
        const submissions = yield* Ref.make(0);
        const defect = new Error("private pacing validation defect");

        const cause = Cause.combine(
          Cause.fail(new EmailInvalidMessage({ issues: [{ path: "sendAt", problem: "Expired" }] })),
          Cause.die(defect),
        );

        const layer = pacingLayer(
          () => Ref.update(submissions, (count) => count + 1).pipe(Effect.as(receipt)),
          () =>
            Ref.updateAndGet(validation, (count) => count + 1).pipe(
              Effect.flatMap((count) => (count === 1 ? Effect.void : Effect.failCause(cause))),
            ),
        );

        const result = yield* Email.use((email) => email.send(message)).pipe(
          Effect.provide(emailLayer(policy).pipe(Layer.provide(layer))),
          Effect.exit,
        );

        assert(Exit.isFailure(result));
        assert(Cause.hasDies(result.cause));
        assert.strictEqual(yield* Ref.get(submissions), 0);
      }),
  );

  it.effect(
    "rechecks early wakeups using the acquired monotonic clock despite caller and wall-clock changes",
    () =>
      Effect.gen(function* recheckMonotonicAdmission() {
        const baseClock = yield* Clock.Clock;
        const now = yield* Ref.make(0n);
        const wall = yield* Ref.make(0);
        const sleeps = yield* Ref.make<readonly bigint[]>([]);
        const admitted = yield* Ref.make<readonly bigint[]>([]);

        const acquiredClock: Clock.Clock = {
          currentTimeMillis: Ref.get(wall),
          currentTimeMillisUnsafe: () => Ref.getUnsafe(wall),
          currentTimeNanos: Ref.get(wall).pipe(Effect.map((millis) => BigInt(millis) * 1_000_000n)),
          currentTimeNanosUnsafe: () => BigInt(Ref.getUnsafe(wall)) * 1_000_000n,
          monotonicTimeNanos: Ref.get(now),
          monotonicTimeNanosUnsafe: () => Ref.getUnsafe(now),
          sleep: (duration) =>
            Ref.update(sleeps, (current) => [...current, Duration.toNanosUnsafe(duration)]).pipe(
              Effect.andThen(Ref.update(now, (current) => current + 50_000_000n)),
            ),
        };

        const callerClock: Clock.Clock = {
          currentTimeMillis: baseClock.currentTimeMillis,
          currentTimeMillisUnsafe: () => baseClock.currentTimeMillisUnsafe(),
          currentTimeNanos: baseClock.currentTimeNanos,
          currentTimeNanosUnsafe: () => baseClock.currentTimeNanosUnsafe(),
          monotonicTimeNanos: Effect.succeed(-1n),
          monotonicTimeNanosUnsafe: () => -1n,
          sleep: () => Effect.die(new Error("Pacing used a caller-local clock")),
        };

        const sender = yield* EmailSender.pipe(
          Effect.provide(
            pacingLayer(() =>
              Ref.get(now).pipe(
                Effect.tap((time) => Ref.update(admitted, (current) => [...current, time])),
                Effect.as(receipt),
              ),
            ),
          ),
          Effect.provideService(Clock.Clock, acquiredClock),
        );

        const parsed = yield* parseEmailMessage(message);
        yield* sender.submit({ message: parsed });
        yield* Ref.set(wall, 1_000_000);
        yield* sender
          .submit({ message: parsed })
          .pipe(Effect.provideService(Clock.Clock, callerClock));
        assert.deepStrictEqual(yield* Ref.get(admitted), [0n, 100_000_000n]);
        assert.deepStrictEqual(yield* Ref.get(sleeps), [100_000_000n, 50_000_000n]);
      }),
  );

  it.effect("rejects non-positive and infinite spacing during acquisition", () =>
    Effect.gen(function* rejectInvalidPacing() {
      for (const minimumSpacing of [
        Duration.zero,
        Duration.millis(-1),
        Duration.infinity,
        Duration.millis(Number.MAX_VALUE),
      ]) {
        const result = yield* EmailSender.pipe(
          Effect.provide(pacedEmailSenderLayer(recordingSenderLayer, { minimumSpacing })),
          Effect.result,
        );

        assert(Result.isFailure(result));
        assert(result.failure instanceof EmailConfigurationError);
      }
    }),
  );
});
