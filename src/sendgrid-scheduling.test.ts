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
import { sendgridEmailLayer, sendgridSenderLayer } from "./sendgrid-email-sender.js";
import type { SendgridEmailOptions } from "./sendgrid-email-sender.js";
import { observedEmailSenderLayer } from "./email-submission-observations.js";
import { resendEmailLayer } from "./resend-email-sender.js";

const clockMillis = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-13T12:00:00Z"));

const message = {
  body: { text: "Fictional notification" },
  from: "sender@fictional.invalid",
  subject: "Fictional schedule",
  to: ["recipient@fictional.invalid"],
} as const;

const options = { apiKey: Redacted.make("fictional-sendgrid-key") };

const policy = { deadline: Duration.seconds(5), initialDelay: Duration.seconds(2), maxAttempts: 3 };

const ScheduledWire = Schema.fromJsonString(Schema.Struct({ send_at: Schema.Int }));

const schedulingInstant = (aheadMillis: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(clockMillis + aheadMillis));

const sendgridOrigin = (region: SendgridEmailOptions["region"]) =>
  region === "Europe" ? "https://api.eu.sendgrid.com" : "https://api.sendgrid.com";

const fixtureScheduledSendgridLayer = (
  fixture: EmailHttpFixture,
  region: SendgridEmailOptions["region"] = "Global",
) =>
  sendgridEmailLayer({ ...options, region }, policy).pipe(
    Layer.provide(emailFixtureClientLayer(fixture.url, sendgridOrigin(region))),
  );

describe("SendGrid scheduling window and revalidation", () => {
  it.effect.each([
    { aheadMillis: 1000, region: "Global" },
    { aheadMillis: 259_199_000, region: "Global" },
    { aheadMillis: 259_200_000, region: "Global" },
    { aheadMillis: 1000, region: "Europe" },
    { aheadMillis: 259_199_000, region: "Europe" },
    { aheadMillis: 259_200_000, region: "Europe" },
  ] as const)(
    "preserves the exact $aheadMillis-millisecond schedule through $region",
    ({ aheadMillis, region }) =>
      Effect.gen(function* preserveSendgridSchedulingEdges() {
        yield* TestClock.setTime(clockMillis);
        const sendAt = schedulingInstant(aheadMillis);
        const fixture = yield* startEmailHttpFixture({ body: "", status: 202 });
        yield* Effect.gen(function* submitSendgridSchedulingEdge() {
          const email = yield* Email;
          yield* email.validate({ ...message, sendAt });
          assert.strictEqual(yield* Queue.size(fixture.received), 0);
          assert(EmailReceiptSchema.guards.Accepted(yield* email.send({ ...message, sendAt })));
        }).pipe(Effect.provide(fixtureScheduledSendgridLayer(fixture, region)));
        const sent = yield* Queue.take(fixture.received);
        const wire = yield* Schema.decodeEffect(ScheduledWire)(sent.body);
        assert.strictEqual(wire.send_at * 1000, clockMillis + aheadMillis);
        assert.strictEqual(sent.idempotencyKey, "");
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );

  it.effect.prop(
    "preserves generated whole Unix instants with fractional current clocks",
    {
      leadSeconds: Schema.Int.check(Schema.isBetween({ maximum: 259_199, minimum: 1 })),
      nowMillis: Schema.Int.check(Schema.isBetween({ maximum: 4_102_444_800_000, minimum: 0 })),
      region: Schema.Literals(["Global", "Europe"]),
    },
    ({ leadSeconds, nowMillis, region }) =>
      Effect.gen(function* preserveGeneratedSendgridSchedule() {
        yield* TestClock.setTime(nowMillis);
        const epochSeconds = Math.floor(nowMillis / 1000) + leadSeconds;
        const instant = DateTime.makeUnsafe(epochSeconds * 1000);
        const fixture = yield* startEmailHttpFixture({ body: "", status: 202 });

        const receipt = yield* Email.pipe(
          Effect.flatMap((email) => email.send({ ...message, sendAt: instant })),
          Effect.provide(fixtureScheduledSendgridLayer(fixture, region)),
        );

        assert(EmailReceiptSchema.guards.Accepted(receipt));

        const wire = yield* Schema.decodeEffect(ScheduledWire)(
          (yield* Queue.take(fixture.received)).body,
        );

        assert.strictEqual(wire.send_at, epochSeconds);
        assert.strictEqual(wire.send_at * 1000, DateTime.toEpochMillis(instant));
      }),
    { arbitrary: { runs: 12 } },
  );

  it.effect.each([-1000, 0, 999, 259_201_000])(
    "refuses a schedule %i milliseconds ahead at validation, send and direct submission without rounding or HTTP",
    (aheadMillis) =>
      Effect.gen(function* rejectOutsideSendgridSchedulingWindow() {
        yield* TestClock.setTime(clockMillis);
        const sendAt = schedulingInstant(aheadMillis);
        const input = { ...message, sendAt };
        const fixture = yield* startEmailHttpFixture({ body: "", status: 202 });
        yield* Effect.gen(function* preflightSendgridScheduleWindow() {
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
        }).pipe(Effect.provide(fixtureScheduledSendgridLayer(fixture)));

        const direct = yield* Effect.gen(function* submitInvalidDirectSendgridSchedule() {
          return yield* (yield* EmailSender).submit({ message: yield* parseEmailMessage(input) });
        }).pipe(
          Effect.provide(
            sendgridSenderLayer(options).pipe(
              Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.sendgrid.com")),
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

  it.effect(
    "preserves safe whole Unix seconds without borrowing another provider's ISO year limit",
    () =>
      Effect.gen(function* preserveExtendedSendgridUnixInstant() {
        yield* TestClock.setTime(
          DateTime.toEpochMillis(DateTime.makeUnsafe("9999-12-31T00:00:00Z")),
        );
        const instant = DateTime.makeUnsafe("+010000-01-01T00:00:00Z");
        const fixture = yield* startEmailHttpFixture({ body: "", status: 202 });

        const receipt = yield* Email.pipe(
          Effect.flatMap((email) => email.send({ ...message, sendAt: instant })),
          Effect.provide(fixtureScheduledSendgridLayer(fixture)),
        );

        assert(EmailReceiptSchema.guards.Accepted(receipt));

        const wire = yield* Schema.decodeEffect(ScheduledWire)(
          (yield* Queue.take(fixture.received)).body,
        );

        assert.strictEqual(wire.send_at * 1000, DateTime.toEpochMillis(instant));
      }),
  );

  it.effect("checks the SendGrid backup horizon before a compatible primary can submit", () =>
    Effect.gen(function* preflightSendgridBackupWindow() {
      yield* TestClock.setTime(clockMillis);

      const primary = yield* startEmailHttpFixture({
        body: JSON.stringify({ id: "fictional-primary-id" }),
        status: 200,
      });

      const backup = yield* startEmailHttpFixture({ body: "", status: 202 });
      const input = { ...message, sendAt: schedulingInstant(259_201_000) };

      const primaryLayer = resendEmailLayer(
        { apiKey: Redacted.make("fictional-primary-key") },
        policy,
      ).pipe(Layer.provide(emailFixtureClientLayer(primary.url, "https://api.resend.com")));

      yield* Email.pipe(
        Effect.flatMap((email) => email.validate(input)),
        Effect.provide(primaryLayer),
      );

      const result = yield* Email.pipe(
        Effect.flatMap((email) => email.send(input)),
        Effect.provide(
          emailRouterLayer(
            [
              { layer: primaryLayer, name: "primary" },
              { layer: fixtureScheduledSendgridLayer(backup), name: "backup" },
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
    "rechecks expiry after successful preflight without retaining dates or fabricating remote status",
    () =>
      Effect.gen(function* expirePreflightedSendgridSchedule() {
        yield* TestClock.setTime(clockMillis);
        const fixture = yield* startEmailHttpFixture({ body: "", status: 202 });
        const trace = yield* startEmailTraceFixture();
        const sendAt = schedulingInstant(1000);

        const result = yield* Effect.gen(function* submitExpiredDirectSendgridSchedule() {
          const sender = yield* EmailSender;

          const owned = yield* parseEmailMessage({
            ...message,
            sendAt,
            subject: "private-scheduled-subject",
          });

          yield* sender.validate(owned);
          yield* TestClock.adjust(1000);

          return yield* sender.submit({ message: owned });
        }).pipe(
          Effect.provide(
            sendgridSenderLayer(options).pipe(
              Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.sendgrid.com")),
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

  it.effect(
    "owns queued schedules and refuses expiry instead of sending immediately when a slot opens",
    () =>
      Effect.gen(function* expireQueuedSendgridSchedule() {
        yield* TestClock.setTime(clockMillis);
        const firstSendAt = schedulingInstant(60_000);
        const fixture = yield* startEmailHttpFixture({ body: "", status: 202 });
        const entered = yield* Deferred.make<boolean>();
        const release = yield* Deferred.make<boolean>();
        const starts = yield* Ref.make(0);

        const sender = observedEmailSenderLayer(sendgridSenderLayer(options), {}, undefined, () =>
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

        const queued = { ...message, sendAt: schedulingInstant(1000) };

        const results = yield* Effect.gen(function* queueOwnedSendgridSchedule() {
          const email = yield* Email;

          const batch = yield* email
            .sendAll([{ message: { ...message, sendAt: firstSendAt } }, { message: queued }], {
              concurrency: 1,
            })
            .pipe(Effect.forkChild);

          yield* Deferred.await(entered);
          queued.sendAt = firstSendAt;
          yield* TestClock.adjust(1000);
          yield* Deferred.succeed(release, true);

          return yield* Fiber.join(batch);
        }).pipe(
          Effect.provide(
            emailLayer(policy).pipe(
              Layer.provide(sender),
              Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.sendgrid.com")),
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

  it.effect("keeps the owned Unix instant when safe-rejection backoff consumes its lead", () =>
    Effect.gen(function* expireSendgridScheduleDuringBackoff() {
      yield* TestClock.setTime(clockMillis);
      const sendAt = schedulingInstant(1000);
      const retryReady = yield* Deferred.make<boolean>();

      const fixture = yield* startEmailHttpFixture({
        body: "private-rate-limit",
        next: { body: "", status: 202 },
        retryAfter: "2",
        status: 429,
      });

      const fiber = yield* Email.pipe(
        Effect.flatMap((email) => email.send({ ...message, sendAt })),
        Effect.provide(
          sendgridEmailLayer(options, policy, () =>
            Deferred.succeed(retryReady, true).pipe(Effect.asVoid),
          ).pipe(Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.sendgrid.com"))),
        ),
        Effect.result,
        Effect.forkScoped,
      );

      const first = yield* Queue.take(fixture.received);
      const wire = yield* Schema.decodeEffect(ScheduledWire)(first.body);
      assert.strictEqual(wire.send_at * 1000, clockMillis + 1000);
      yield* Deferred.await(retryReady);
      yield* TestClock.adjust(3000);
      const result = yield* Fiber.join(fiber);
      assert(Result.isFailure(result));
      assert(result.failure instanceof EmailRejected);
      assert.strictEqual(result.failure.reason, "invalid-message");
      assert.strictEqual(yield* Queue.size(fixture.received), 0);
    }),
  );

  it.effect("retains unkeyed uncertainty through schedule expiry without retry or fallback", () =>
    Effect.gen(function* preserveUncertainSendgridSchedule() {
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

      const observed = observedEmailSenderLayer(sendgridSenderLayer(options), {}, () =>
        Deferred.succeed(settled, true).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.asVoid,
        ),
      );

      const routes = emailRouterLayer(
        [
          {
            layer: emailLayer(policy).pipe(
              Layer.provide(observed),
              Layer.provide(emailFixtureClientLayer(primary.url, "https://api.sendgrid.com")),
            ),
            name: "primary",
          },
          {
            layer: resendEmailLayer({ apiKey: Redacted.make("fictional-backup-key") }, policy).pipe(
              Layer.provide(emailFixtureClientLayer(backup.url, "https://api.resend.com")),
            ),
            name: "backup",
          },
        ],
        { fallbacks: ["backup"], primary: "primary" },
      );

      const fiber = yield* Email.pipe(
        Effect.flatMap((email) => email.send({ ...message, sendAt: schedulingInstant(1000) })),
        Effect.provide(routes),
        Effect.result,
        Effect.forkScoped,
      );

      yield* Queue.take(primary.received);
      yield* Deferred.await(settled);
      yield* TestClock.adjust(1000);
      yield* Deferred.succeed(release, true);
      const result = yield* Fiber.join(fiber);
      assert(Result.isFailure(result));
      assert(result.failure instanceof EmailDeliveryUnknown);
      assert.strictEqual(result.failure.reason, "server-error");
      assert.strictEqual(yield* Queue.size(primary.received), 0);
      assert.strictEqual(yield* Queue.size(backup.received), 0);
    }),
  );

  it.effect("omits scheduling for immediate intent instead of inventing a timestamp", () =>
    Effect.gen(function* preserveImmediateSendgridIntent() {
      const fixture = yield* startEmailHttpFixture({ body: "", status: 202 });

      const receipt = yield* Email.pipe(
        Effect.flatMap((email) => email.send(message)),
        Effect.provide(fixtureScheduledSendgridLayer(fixture)),
      );

      assert(EmailReceiptSchema.guards.Accepted(receipt));

      const wire = yield* Schema.decodeEffect(
        Schema.fromJsonString(Schema.Struct({ send_at: Schema.optionalKey(Schema.Int) })),
      )((yield* Queue.take(fixture.received)).body);

      assert.notProperty(wire, "send_at");
    }),
  );

  it.effect(
    "keeps scheduled 202 acceptance terminal without inventing an ID, held-job proof or backup send",
    () =>
      Effect.gen(function* preserveScheduledSendgridAcceptance() {
        yield* TestClock.setTime(clockMillis);

        const primary = yield* startEmailHttpFixture({
          body: JSON.stringify({ id: "private-untrusted-id", scheduled: true }),
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
                { layer: fixtureScheduledSendgridLayer(primary), name: "primary" },
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

        assert(EmailReceiptSchema.guards.Accepted(receipt));
        assert.isUndefined(receipt.messageId);
        assert.notInclude(JSON.stringify(receipt), "private-untrusted-id");
        assert.strictEqual(yield* Queue.size(primary.received), 1);
        assert.strictEqual(yield* Queue.size(backup.received), 0);
      }),
  );
});
