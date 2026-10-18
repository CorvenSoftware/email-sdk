import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Fiber, Layer, Result, Schema, Tracer } from "effect";
import { TestClock } from "effect/testing";
import { startEmailTraceFixture } from "../test/email-tracing-fixture.js";
import {
  Email,
  EmailDeliveryUnknown,
  EmailInvalidMessage,
  EmailReceiptSchema,
  EmailRejected,
  EmailRouter,
  emailRouterLayer,
} from "./index.js";
import { FailedEmailSubmissions, failingEmailLayer } from "./failing-email-sender.js";
import { recordingEmailLayer } from "./recording-email-sender.js";

const message = {
  body: { text: "private-body" },
  from: "sender@example.test",
  subject: "private-subject",
  to: "private-recipient@example.test",
} as const;

const singleAttempt = {
  deadline: Duration.seconds(5),
  initialDelay: Duration.millis(100),
  maxAttempts: 1,
};

describe("Explicit synthetic failing email Layers", () => {
  it.effect(
    "owns configured failures and attempted messages without retaining private tracer exits",
    () =>
      Effect.gen(function* observeOwnedSyntheticFailure() {
        const failure = new EmailRejected({
          provider: "fictional-provider",
          reason: "authentication",
          status: 401,
        });

        const layer = failingEmailLayer(failure, singleAttempt);
        const trace = yield* startEmailTraceFixture();
        yield* Effect.gen(function* executeSyntheticFailure() {
          const email = yield* Email;
          const captured = yield* FailedEmailSubmissions;
          Reflect.set(failure, "reason", "rate-limited");
          const input = { ...message, body: { text: message.body.text } };
          const error = yield* email.send(input).pipe(Effect.flip);
          assert(Schema.is(EmailRejected)(error));
          assert.strictEqual(error.reason, "authentication");
          assert.strictEqual(error.provider, "failing");
          Reflect.set(input.body, "text", "changed-private-body");
          const attempts = yield* captured.attempts;
          assert.strictEqual(attempts.length, 1);
          assert.strictEqual(attempts[0]?.message.body.text, message.body.text);
          assert.isTrue(Object.isFrozen(attempts));
          const [attempted] = attempts;
          assert.isDefined(attempted);
          Reflect.set(attempted.message.body, "text", "observer-private-mutation");
          assert.strictEqual((yield* captured.attempts)[0]?.message.body.text, message.body.text);
        }).pipe(Effect.provide(layer), Effect.provideService(Tracer.Tracer, trace.tracer));
        const diagnostics = yield* trace.diagnostics;
        assert.notInclude(diagnostics, "private");
        assert.include(diagnostics, "FailingEmailSender.submit");
      }),
  );

  it.effect(
    "settles input failures without attempting them and refuses synthetic replay keys",
    () =>
      Effect.gen(function* settleSyntheticBatch() {
        const email = yield* Email;
        const captured = yield* FailedEmailSubmissions;

        const unsupportedKey = yield* email
          .send(message, { idempotencyKey: "private-key" })
          .pipe(Effect.flip);

        assert(Schema.is(EmailRejected)(unsupportedKey));
        assert.strictEqual(unsupportedKey.reason, "unsupported-idempotency");
        const invalid = { ...message, subject: "private\nheader" };
        const batch = yield* email.sendAll([{ message }, { message: invalid }]);
        const [remote, local] = batch;
        assert.isDefined(remote);
        assert.isDefined(local);
        assert(Result.isFailure(remote));
        assert(Result.isFailure(local));
        assert(Schema.is(EmailRejected)(remote.failure));
        assert(Schema.is(EmailInvalidMessage)(local.failure));
        assert.strictEqual((yield* captured.attempts).length, 1);
      }).pipe(
        Effect.provide(
          failingEmailLayer(
            new EmailRejected({ provider: "fixture", reason: "rejected" }),
            singleAttempt,
          ),
        ),
      ),
  );

  it.effect("uses real virtual-time retry policy only for definite rate rejection", () =>
    Effect.gen(function* exhaustSyntheticBackoff() {
      const email = yield* Email;
      const captured = yield* FailedEmailSubmissions;
      const operation = yield* email.send(message).pipe(Effect.forkScoped);
      yield* TestClock.adjust(Duration.seconds(2));
      const failure = yield* Fiber.join(operation).pipe(Effect.flip);
      assert(Schema.is(EmailRejected)(failure));
      assert.strictEqual(failure.reason, "rate-limited");
      assert.strictEqual((yield* captured.attempts).length, 3);
    }).pipe(
      Effect.provide(
        failingEmailLayer(
          new EmailRejected({ provider: "fixture", reason: "rate-limited", retryAfterMillis: 200 }),
          { ...singleAttempt, maxAttempts: 3 },
        ),
      ),
    ),
  );

  it.effect.each([false, true])(
    "permits synthetic fallback only for definite rejection (unknown: %s)",
    (unknown) =>
      Effect.gen(function* routeSyntheticFailure() {
        const route = yield* (yield* EmailRouter).select();
        const outcome = yield* route.send(message).pipe(Effect.result);

        if (unknown) {
          assert(Result.isFailure(outcome));
          assert(Schema.is(EmailDeliveryUnknown)(outcome.failure));
        } else {
          assert(Result.isSuccess(outcome));
          assert(EmailReceiptSchema.guards.Recorded(outcome.success));
          assert.strictEqual(outcome.success.route, "backup");
        }
      }).pipe(
        Effect.provide(
          emailRouterLayer(
            [
              {
                layer: failingEmailLayer(
                  unknown
                    ? new EmailDeliveryUnknown({ provider: "fixture", reason: "server-error" })
                    : new EmailRejected({ provider: "fixture", reason: "authentication" }),
                  singleAttempt,
                ),
                name: "primary",
              },
              { layer: Layer.fresh(recordingEmailLayer), name: "backup" },
            ],
            { fallbacks: ["backup"], primary: "primary" },
          ),
        ),
      ),
  );
});
