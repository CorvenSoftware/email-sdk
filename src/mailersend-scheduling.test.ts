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
  EmailDeliveryUnknown,
  EmailInvalidMessage,
  EmailReceiptSchema,
  EmailRejected,
  EmailSender,
  emailLayer,
  emailRouterLayer,
  parseEmailMessage,
} from "./index.js";
import { mailersendEmailLayer, mailersendSenderLayer } from "./mailersend-email-sender.js";
import { observedEmailSenderLayer } from "./email-submission-observations.js";
import { resendEmailLayer } from "./resend-email-sender.js";

const clockMillis = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-13T12:00:00Z"));

const message = {
  body: { text: "Fictional notification" },
  from: "sender@fictional.invalid",
  subject: "Fictional schedule",
  to: ["recipient@fictional.invalid"],
} as const;

const options = { apiKey: Redacted.make("fictional-mailersend-key") };

const policy = { deadline: Duration.seconds(5), initialDelay: Duration.seconds(2), maxAttempts: 3 };

const ScheduledWire = Schema.fromJsonString(Schema.Struct({ send_at: Schema.String }));

const schedulingInstant = (aheadMillis: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(clockMillis + aheadMillis));

const fixtureScheduledMailersendLayer = (fixture: EmailHttpFixture) =>
  mailersendEmailLayer(options, policy).pipe(
    Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.mailersend.com")),
  );

describe("MailerSend scheduling window and revalidation", () => {
  it.effect.each([0, 1, 259_199_999, 259_200_000])(
    "preserves the inclusive scheduling edge at %i milliseconds ahead",
    (aheadMillis) =>
      Effect.gen(function* preserveMailersendSchedulingEdges() {
        yield* TestClock.setTime(clockMillis);
        const sendAt = schedulingInstant(aheadMillis);

        const fixture = yield* startEmailHttpFixture({
          body: "",
          contentType: "text/plain",
          messageId: "fictional-schedule-id",
          status: 202,
        });

        yield* Effect.gen(function* submitMailersendSchedulingEdge() {
          const email = yield* Email;
          yield* email.validate({ ...message, sendAt });
          assert.strictEqual(yield* Queue.size(fixture.received), 0);
          assert(EmailReceiptSchema.guards.Accepted(yield* email.send({ ...message, sendAt })));
        }).pipe(Effect.provide(fixtureScheduledMailersendLayer(fixture)));
        const sent = yield* Queue.take(fixture.received);
        const wire = yield* Schema.decodeEffect(ScheduledWire)(sent.body);
        assert.strictEqual(wire.send_at, sendAt);
        assert.strictEqual(sent.idempotencyKey, "");
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );

  it.effect.prop(
    "preserves generated UTC dates and fractional seconds without rounding",
    {
      aheadMillis: Schema.Int.check(Schema.isBetween({ maximum: 259_200_000, minimum: 0 })),
      nowMillis: Schema.Int.check(Schema.isBetween({ maximum: 4_102_444_800_000, minimum: 0 })),
    },
    ({ aheadMillis, nowMillis }) =>
      Effect.gen(function* preserveGeneratedMailersendSchedule() {
        yield* TestClock.setTime(nowMillis);
        const instant = DateTime.makeUnsafe(nowMillis + aheadMillis);

        const fixture = yield* startEmailHttpFixture({
          body: "",
          contentType: "text/plain",
          messageId: "fictional-schedule-id",
          status: 202,
        });

        const receipt = yield* Email.pipe(
          Effect.flatMap((email) => email.send({ ...message, sendAt: instant })),
          Effect.provide(fixtureScheduledMailersendLayer(fixture)),
        );

        assert(EmailReceiptSchema.guards.Accepted(receipt));

        const wire = yield* Schema.decodeEffect(ScheduledWire)(
          (yield* Queue.take(fixture.received)).body,
        );

        assert.strictEqual(wire.send_at, DateTime.formatIso(instant));
        assert.strictEqual(
          DateTime.toEpochMillis(DateTime.makeUnsafe(wire.send_at)) - nowMillis,
          aheadMillis,
        );
      }),
    { arbitrary: { runs: 12 } },
  );

  it.effect.each([-1, 259_200_001])(
    "refuses a schedule %i milliseconds ahead at validation, send and direct submission before HTTP",
    (aheadMillis) =>
      Effect.gen(function* rejectOutsideMailersendSchedulingWindow() {
        yield* TestClock.setTime(clockMillis);
        const sendAt = schedulingInstant(aheadMillis);
        const input = { ...message, sendAt };

        const fixture = yield* startEmailHttpFixture({
          body: "",
          contentType: "text/plain",
          messageId: "fictional-schedule-id",
          status: 202,
        });

        yield* Effect.gen(function* preflightMailersendScheduleWindow() {
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
        }).pipe(Effect.provide(fixtureScheduledMailersendLayer(fixture)));

        const direct = yield* Effect.gen(function* submitInvalidDirectMailersendSchedule() {
          return yield* (yield* EmailSender).submit({ message: yield* parseEmailMessage(input) });
        }).pipe(
          Effect.provide(
            mailersendSenderLayer(options).pipe(
              Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.mailersend.com")),
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

  it.effect("refuses an expanded UTC year inside the window rather than changing it", () =>
    Effect.gen(function* refuseExpandedMailersendYear() {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("9999-12-31T00:00:00Z")));

      const fixture = yield* startEmailHttpFixture({
        body: "",
        contentType: "text/plain",
        messageId: "fictional-schedule-id",
        status: 202,
      });

      const result = yield* Email.pipe(
        Effect.flatMap((email) =>
          email.send({ ...message, sendAt: DateTime.makeUnsafe("+010000-01-01T00:00:00Z") }),
        ),
        Effect.provide(fixtureScheduledMailersendLayer(fixture)),
        Effect.result,
      );

      assert(Result.isFailure(result));
      assert(result.failure instanceof EmailInvalidMessage);
      assert.strictEqual(yield* Queue.size(fixture.received), 0);
    }),
  );

  it.effect("checks the MailerSend backup window before a compatible primary can submit", () =>
    Effect.gen(function* preflightMailersendBackupWindow() {
      yield* TestClock.setTime(clockMillis);

      const primary = yield* startEmailHttpFixture({
        body: JSON.stringify({ id: "fictional-primary-id" }),
        status: 200,
      });

      const backup = yield* startEmailHttpFixture({
        body: "",
        contentType: "text/plain",
        messageId: "fictional-schedule-id",
        status: 202,
      });

      const result = yield* Email.pipe(
        Effect.flatMap((email) =>
          email.send({ ...message, sendAt: schedulingInstant(259_200_001) }),
        ),
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
              { layer: fixtureScheduledMailersendLayer(backup), name: "backup" },
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
    "rechecks expiry after preflight without leaking dates or inventing a remote status",
    () =>
      Effect.gen(function* expirePreflightedMailersendSchedule() {
        yield* TestClock.setTime(clockMillis);

        const fixture = yield* startEmailHttpFixture({
          body: "",
          contentType: "text/plain",
          messageId: "fictional-schedule-id",
          status: 202,
        });

        const trace = yield* startEmailTraceFixture();
        const sendAt = schedulingInstant(0);

        const result = yield* Effect.gen(function* submitExpiredDirectMailersendSchedule() {
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
            mailersendSenderLayer(options).pipe(
              Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.mailersend.com")),
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

  it.effect("owns queued schedules and refuses expiry when a batch slot opens", () =>
    Effect.gen(function* expireQueuedMailersendSchedule() {
      yield* TestClock.setTime(clockMillis);
      const firstSendAt = schedulingInstant(60_000);

      const fixture = yield* startEmailHttpFixture({
        body: "",
        contentType: "text/plain",
        messageId: "fictional-schedule-id",
        status: 202,
      });

      const entered = yield* Deferred.make<boolean>();
      const release = yield* Deferred.make<boolean>();
      const starts = yield* Ref.make(0);

      const sender = observedEmailSenderLayer(mailersendSenderLayer(options), {}, undefined, () =>
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

      const queued = { ...message, sendAt: schedulingInstant(0) };

      const results = yield* Effect.gen(function* queueOwnedMailersendSchedule() {
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
            Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.mailersend.com")),
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
    "keeps the original instant when definite-rejection backoff consumes its remaining lead",
    () =>
      Effect.gen(function* expireMailersendScheduleDuringBackoff() {
        yield* TestClock.setTime(clockMillis);
        const sendAt = schedulingInstant(1000);
        const retryReady = yield* Deferred.make<boolean>();

        const fixture = yield* startEmailHttpFixture({
          body: "private-rate-limit",
          next: {
            body: "",
            contentType: "text/plain",
            messageId: "fictional-schedule-id",
            status: 202,
          },
          status: 429,
        });

        const fiber = yield* Email.pipe(
          Effect.flatMap((email) => email.send({ ...message, sendAt })),
          Effect.provide(
            mailersendEmailLayer(options, policy, () =>
              Deferred.succeed(retryReady, true).pipe(Effect.asVoid),
            ).pipe(
              Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.mailersend.com")),
            ),
          ),
          Effect.result,
          Effect.forkScoped,
        );

        const first = yield* Queue.take(fixture.received);
        const wire = yield* Schema.decodeEffect(ScheduledWire)(first.body);
        assert.strictEqual(wire.send_at, sendAt);
        yield* Deferred.await(retryReady);
        yield* TestClock.adjust(3000);
        const result = yield* Fiber.join(fiber);
        assert(Result.isFailure(result));
        assert(result.failure instanceof EmailRejected);
        assert.strictEqual(result.failure.reason, "invalid-message");
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );

  it.effect(
    "retains unkeyed uncertainty after the scheduled instant passes without retry or fallback",
    () =>
      Effect.gen(function* preserveUncertainMailersendSchedule() {
        yield* TestClock.setTime(clockMillis);

        const primary = yield* startEmailHttpFixture({
          body: "private-server-evidence",
          status: 500,
        });

        const backup = yield* startEmailHttpFixture({
          body: JSON.stringify({ id: "fictional-backup-id" }),
          status: 200,
        });

        const settled = yield* Deferred.make<boolean>();
        const release = yield* Deferred.make<boolean>();

        const observed = observedEmailSenderLayer(mailersendSenderLayer(options), {}, () =>
          Deferred.succeed(settled, true).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.asVoid,
          ),
        );

        const primaryLayer = emailLayer(policy).pipe(
          Layer.provide(observed),
          Layer.provide(emailFixtureClientLayer(primary.url, "https://api.mailersend.com")),
        );

        const routes = emailRouterLayer(
          [
            { layer: primaryLayer, name: "primary" },
            {
              layer: resendEmailLayer(
                { apiKey: Redacted.make("fictional-backup-key") },
                policy,
              ).pipe(Layer.provide(emailFixtureClientLayer(backup.url, "https://api.resend.com"))),
              name: "backup",
            },
          ],
          { fallbacks: ["backup"], primary: "primary" },
        );

        const fiber = yield* Email.pipe(
          Effect.flatMap((email) => email.send({ ...message, sendAt: schedulingInstant(1) })),
          Effect.provide(routes),
          Effect.result,
          Effect.forkScoped,
        );

        yield* Queue.take(primary.received);
        yield* Deferred.await(settled);
        yield* TestClock.adjust(2);
        yield* Deferred.succeed(release, true);
        const result = yield* Fiber.join(fiber);
        assert(Result.isFailure(result));
        assert(result.failure instanceof EmailDeliveryUnknown);
        assert.strictEqual(result.failure.reason, "server-error");
        assert.strictEqual(yield* Queue.size(primary.received), 0);
        assert.strictEqual(yield* Queue.size(backup.received), 0);
      }),
  );

  it.effect("leaves immediate submissions unscheduled rather than inventing a date", () =>
    Effect.gen(function* preserveImmediateMailersendIntent() {
      const fixture = yield* startEmailHttpFixture({
        body: "",
        contentType: "text/plain",
        messageId: "fictional-immediate-id",
        status: 202,
      });

      const receipt = yield* Email.pipe(
        Effect.flatMap((email) => email.send(message)),
        Effect.provide(fixtureScheduledMailersendLayer(fixture)),
      );

      assert(EmailReceiptSchema.guards.Accepted(receipt));

      const wire = yield* Schema.decodeEffect(
        Schema.fromJsonString(Schema.Struct({ send_at: Schema.optionalKey(Schema.String) })),
      )((yield* Queue.take(fixture.received)).body);

      assert.notProperty(wire, "send_at");
    }),
  );

  it.effect(
    "keeps scheduled suppression terminal without inventing a held job or bypassing through backup",
    () =>
      Effect.gen(function* preserveScheduledMailersendSuppression() {
        yield* TestClock.setTime(clockMillis);

        const primary = yield* startEmailHttpFixture({
          body: JSON.stringify({
            warnings: [{ recipients: [{ email: message.to[0] }], type: "ALL_SUPPRESSED" }],
          }),
          status: 202,
        });

        const backup = yield* startEmailHttpFixture({
          body: JSON.stringify({ id: "fictional-backup-id" }),
          status: 200,
        });

        const receipt = yield* Email.pipe(
          Effect.flatMap((email) => email.send({ ...message, sendAt: schedulingInstant(60_000) })),
          Effect.provide(
            emailRouterLayer(
              [
                { layer: fixtureScheduledMailersendLayer(primary), name: "primary" },
                {
                  layer: resendEmailLayer(
                    { apiKey: Redacted.make("fictional-backup-key") },
                    policy,
                  ).pipe(
                    Layer.provide(emailFixtureClientLayer(backup.url, "https://api.resend.com")),
                  ),
                  name: "backup",
                },
              ],
              { fallbacks: ["backup"], primary: "primary" },
            ),
          ),
        );

        assert(EmailReceiptSchema.guards.Suppressed(receipt));
        assert.strictEqual(yield* Queue.size(primary.received), 1);
        assert.strictEqual(yield* Queue.size(backup.received), 0);
      }),
  );
});
