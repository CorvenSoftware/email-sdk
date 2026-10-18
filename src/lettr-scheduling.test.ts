import { assert, describe, it } from "@effect/vitest";
import {
  DateTime,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Layer,
  Queue,
  Redacted,
  Ref,
  Result,
  Schema,
} from "effect";
import { TestClock } from "effect/testing";
import { emailFixtureClientLayer, startEmailHttpFixture } from "../test/email-http-fixture.js";
import type { EmailHttpFixture } from "../test/email-http-fixture.js";
import { startEmailTraceFixture } from "../test/email-tracing-fixture.js";
import {
  Email,
  EmailInvalidMessage,
  EmailReceiptSchema,
  EmailRejected,
  EmailSender,
  emailRouterLayer,
  emailLayer,
  parseEmailMessage,
} from "./index.js";
import { lettrEmailLayer, lettrSenderLayer } from "./lettr-email-sender.js";
import { resendEmailLayer } from "./resend-email-sender.js";
import { observedEmailSenderLayer } from "./email-submission-observations.js";

const clockMillis = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-14T12:00:00Z"));

const message = {
  body: { text: "Fictional notification" },
  from: "sender@fictional.invalid",
  subject: "Fictional schedule",
  to: ["recipient@fictional.invalid"],
} as const;

const options = {
  apiKey: Redacted.make("lttr_fictional-key"),
  submissionMode: "Scheduled",
} as const;

const policy = {
  deadline: Duration.seconds(5),
  initialDelay: Duration.millis(100),
  maxAttempts: 3,
};

const ScheduledWire = Schema.fromJsonString(Schema.Struct({ scheduled_at: Schema.String }));

const schedulingInstant = (aheadMillis: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(clockMillis + aheadMillis));

const scheduledAcknowledgement = (sendAt: string) =>
  JSON.stringify({
    data: {
      accepted: 1,
      failure_reason: null,
      num_recipients: 1,
      recipients: ["recipient@fictional.invalid"],
      rejected: 0,
      request_id: "sch_fictional-hold",
      scheduled_at: sendAt,
      state: "scheduled",
      transmission_id: null,
    },
  });

const fixtureScheduledLettrLayer = (fixture: EmailHttpFixture) =>
  lettrEmailLayer(options, policy).pipe(
    Layer.provide(emailFixtureClientLayer(fixture.url, "https://app.lettr.com")),
  );

describe("Lettr scheduling window and revalidation", () => {
  it.effect.each([300_000, 300_001, 2_591_999_999, 2_592_000_000])(
    "preserves the exact scheduling edge at %i milliseconds ahead",
    (aheadMillis) =>
      Effect.gen(function* preserveLettrSchedulingEdges() {
        yield* TestClock.setTime(clockMillis);
        const sendAt = schedulingInstant(aheadMillis);

        const fixture = yield* startEmailHttpFixture({
          body: scheduledAcknowledgement(sendAt),
          status: 201,
        });

        yield* Effect.gen(function* submitLettrSchedulingEdge() {
          const email = yield* Email;
          yield* email.validate({ ...message, sendAt });
          assert.strictEqual(yield* Queue.size(fixture.received), 0);
          assert(EmailReceiptSchema.guards.Accepted(yield* email.send({ ...message, sendAt })));
        }).pipe(Effect.provide(fixtureScheduledLettrLayer(fixture)));
        const sent = yield* Queue.take(fixture.received);
        const wire = yield* Schema.decodeEffect(ScheduledWire)(sent.body);
        assert.strictEqual(wire.scheduled_at, sendAt);
        assert.strictEqual(sent.idempotencyKey, "");
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );

  it.effect.prop(
    "preserves generated millisecond instants across UTC dates without rounding",
    {
      aheadMillis: Schema.Int.check(Schema.isBetween({ maximum: 2_592_000_000, minimum: 300_000 })),
      nowMillis: Schema.Int.check(Schema.isBetween({ maximum: 4_102_444_800_000, minimum: 0 })),
    },
    ({ aheadMillis, nowMillis }) =>
      Effect.gen(function* preserveGeneratedLettrSchedule() {
        yield* TestClock.setTime(nowMillis);
        const instant = DateTime.makeUnsafe(nowMillis + aheadMillis);
        const sendAt = DateTime.formatIso(instant);

        const fixture = yield* startEmailHttpFixture({
          body: scheduledAcknowledgement(sendAt),
          status: 201,
        });

        const receipt = yield* Email.pipe(
          Effect.flatMap((email) => email.send({ ...message, sendAt: instant })),
          Effect.provide(fixtureScheduledLettrLayer(fixture)),
        );

        assert(EmailReceiptSchema.guards.Accepted(receipt));
        const sent = yield* Queue.take(fixture.received);
        const wire = yield* Schema.decodeEffect(ScheduledWire)(sent.body);
        assert.strictEqual(wire.scheduled_at, sendAt);
        assert.strictEqual(
          DateTime.toEpochMillis(DateTime.makeUnsafe(wire.scheduled_at)) - nowMillis,
          aheadMillis,
        );
      }),
    { arbitrary: { runs: 12 } },
  );

  it.effect.each([-1, 0, 299_999, 2_592_000_001])(
    "refuses a schedule %i milliseconds ahead at validation, send and direct submission before HTTP",
    (aheadMillis) =>
      Effect.gen(function* rejectOutsideLettrSchedulingWindow() {
        yield* TestClock.setTime(clockMillis);
        const sendAt = schedulingInstant(aheadMillis);
        const input = { ...message, sendAt };

        const fixture = yield* startEmailHttpFixture({
          body: scheduledAcknowledgement(sendAt),
          status: 201,
        });

        yield* Effect.gen(function* preflightLettrScheduleWindow() {
          const email = yield* Email;

          for (const operation of [
            email.validate(input).pipe(Effect.asVoid),
            email.send(input).pipe(Effect.asVoid),
          ]) {
            const invalid = yield* operation.pipe(Effect.result);
            assert(Result.isFailure(invalid));
            assert(invalid.failure instanceof EmailInvalidMessage);
            assert.deepStrictEqual(
              invalid.failure.issues.map(({ path }) => path),
              ["sendAt"],
            );
            assert.notInclude(JSON.stringify(invalid.failure), sendAt);
          }
        }).pipe(Effect.provide(fixtureScheduledLettrLayer(fixture)));

        const direct = yield* Effect.gen(function* submitInvalidDirectLettrSchedule() {
          return yield* (yield* EmailSender).submit({ message: yield* parseEmailMessage(input) });
        }).pipe(
          Effect.provide(
            lettrSenderLayer(options).pipe(
              Layer.provide(emailFixtureClientLayer(fixture.url, "https://app.lettr.com")),
            ),
          ),
          Effect.result,
        );

        assert(Result.isFailure(direct));
        assert(direct.failure instanceof EmailRejected);
        assert.strictEqual(direct.failure.reason, "invalid-message");
        assert.notProperty(direct.failure, "status");
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );

  it.effect("refuses an expanded UTC year inside the time window rather than changing it", () =>
    Effect.gen(function* refuseExpandedLettrYear() {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("9999-12-31T00:00:00Z")));
      const fixture = yield* startEmailHttpFixture({ body: "{}", status: 201 });

      const result = yield* Email.pipe(
        Effect.flatMap((email) =>
          email.send({ ...message, sendAt: DateTime.makeUnsafe("+010000-01-01T00:00:00Z") }),
        ),
        Effect.provide(fixtureScheduledLettrLayer(fixture)),
        Effect.result,
      );

      assert(Result.isFailure(result));
      assert(result.failure instanceof EmailInvalidMessage);
      assert.strictEqual(yield* Queue.size(fixture.received), 0);
    }),
  );

  it.effect(
    "preflights the Lettr backup lead time before an otherwise compatible primary can submit",
    () =>
      Effect.gen(function* preflightLettrBackupLeadTime() {
        yield* TestClock.setTime(clockMillis);

        const primary = yield* startEmailHttpFixture({
          body: JSON.stringify({ id: "primary-id" }),
          status: 200,
        });

        const backup = yield* startEmailHttpFixture({ body: "{}", status: 201 });

        const result = yield* Email.pipe(
          Effect.flatMap((email) => email.send({ ...message, sendAt: schedulingInstant(299_999) })),
          Effect.provide(
            emailRouterLayer(
              [
                {
                  layer: resendEmailLayer(
                    { apiKey: Redacted.make("fictional-primary-key") },
                    policy,
                  ).pipe(
                    Layer.provide(emailFixtureClientLayer(primary.url, "https://api.resend.com")),
                  ),
                  name: "primary",
                },
                { layer: fixtureScheduledLettrLayer(backup), name: "backup" },
              ],
              { fallbacks: ["backup"], primary: "primary" },
            ),
          ),
          Effect.result,
        );

        assert(Result.isFailure(result));
        assert(result.failure instanceof EmailInvalidMessage);
        assert.strictEqual(yield* Queue.size(primary.received), 0);
        assert.strictEqual(yield* Queue.size(backup.received), 0);
      }),
  );

  it.effect(
    "rechecks lead time after preflight without retaining private dates or inventing a status",
    () =>
      Effect.gen(function* expirePreflightedLettrSchedule() {
        yield* TestClock.setTime(clockMillis);
        const fixture = yield* startEmailHttpFixture({ body: "{}", status: 201 });
        const trace = yield* startEmailTraceFixture();
        const sendAt = schedulingInstant(300_000);

        const result = yield* Effect.gen(function* submitExpiredDirectLettrSchedule() {
          const sender = yield* EmailSender;

          const owned = yield* parseEmailMessage({
            ...message,
            sendAt,
            subject: "private-scheduled-subject",
          });

          yield* sender.validate(owned);
          yield* TestClock.adjust(1);

          return yield* sender.submit({ message: owned });
        }).pipe(
          Effect.provide(
            lettrSenderLayer(options).pipe(
              Layer.provide(emailFixtureClientLayer(fixture.url, "https://app.lettr.com")),
            ),
          ),
          Effect.withTracer(trace.tracer),
          Effect.result,
        );

        assert(Result.isFailure(result));
        assert(result.failure instanceof EmailRejected);
        assert.strictEqual(result.failure.reason, "invalid-message");
        assert.notProperty(result.failure, "status");
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
        const diagnostics = yield* trace.diagnostics;
        assert.notInclude(diagnostics, sendAt);
        assert.notInclude(diagnostics, "private-scheduled-subject");
      }),
  );

  it.effect("owns queued schedules and refuses lost lead time when a batch slot opens", () =>
    Effect.gen(function* expireQueuedLettrSchedule() {
      yield* TestClock.setTime(clockMillis);
      const firstSendAt = schedulingInstant(1_200_000);

      const fixture = yield* startEmailHttpFixture({
        body: scheduledAcknowledgement(firstSendAt),
        status: 201,
      });

      const entered = yield* Deferred.make<boolean>();
      const release = yield* Deferred.make<boolean>();

      const starts = yield* Ref.make(0);

      const sender = observedEmailSenderLayer(lettrSenderLayer(options), {}, undefined, () =>
        Ref.updateAndGet(starts, (count) => count + 1).pipe(
          Effect.flatMap((count) =>
            count === 1
              ? Deferred.succeed(entered, true).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.asVoid,
                )
              : Effect.void,
          ),
        ),
      );

      const queued = { ...message, sendAt: schedulingInstant(300_000) };

      const results = yield* Effect.gen(function* queueOwnedLettrSchedule() {
        const email = yield* Email;

        const batch = yield* email
          .sendAll([{ message: { ...message, sendAt: firstSendAt } }, { message: queued }], {
            concurrency: 1,
          })
          .pipe(Effect.forkChild);

        yield* Deferred.await(entered);
        queued.sendAt = firstSendAt;
        yield* TestClock.adjust(1);
        yield* Deferred.succeed(release, true);

        return yield* Fiber.join(batch);
      }).pipe(
        Effect.provide(
          emailLayer(policy).pipe(
            Layer.provide(sender),
            Layer.provide(emailFixtureClientLayer(fixture.url, "https://app.lettr.com")),
          ),
        ),
      );

      const [first, second] = results;
      assert(first !== undefined && Result.isSuccess(first));
      assert(second !== undefined && Result.isFailure(second));
      assert(second.failure instanceof EmailRejected);
      assert.strictEqual(second.failure.reason, "invalid-message");
      assert.strictEqual(yield* Queue.size(fixture.received), 1);
    }),
  );

  it.effect(
    "does not shift an instant when eligible rejection backoff consumes its lead time",
    () =>
      Effect.gen(function* expireLettrScheduleDuringBackoff() {
        yield* TestClock.setTime(clockMillis);
        const sendAt = schedulingInstant(300_001);

        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify({
            error_code: "rate_limit_exceeded",
            message: "private-rate-limit",
          }),
          next: { body: scheduledAcknowledgement(sendAt), status: 201 },
          retryAfter: "2",
          status: 429,
        });

        const fiber = yield* Email.pipe(
          Effect.flatMap((email) => email.send({ ...message, sendAt })),
          Effect.provide(fixtureScheduledLettrLayer(fixture)),
          Effect.result,
          Effect.forkScoped,
        );

        const first = yield* Queue.take(fixture.received);
        const wire = yield* Schema.decodeEffect(ScheduledWire)(first.body);
        assert.strictEqual(wire.scheduled_at, sendAt);
        assert.strictEqual(first.idempotencyKey, "");
        yield* TestClock.adjust(2000);
        const result = yield* Fiber.join(fiber);
        assert(Result.isFailure(result));
        assert(result.failure instanceof EmailRejected);
        assert.strictEqual(result.failure.reason, "invalid-message");
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );
});
