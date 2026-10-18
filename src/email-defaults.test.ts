import { assert, describe, it } from "@effect/vitest";
import { Deferred, Duration, Effect, Exit, Fiber, Layer, Queue, Ref, Result, Schema } from "effect";
import { TestClock } from "effect/testing";
import { startEmailTraceFixture } from "../test/email-tracing-fixture.js";
import { formatEmailMailbox } from "./email-address.js";
import { defaultedEmailLayer } from "./email-defaults.js";
import type { EmailDefaultsInput } from "./email-defaults.js";
import { EmailConfigurationError } from "./email-configuration-error.js";
import { EmailDeliveryUnknown } from "./email-delivery-unknown.js";
import { EmailInvalidMessage } from "./email-invalid-message.js";
import { EmailInvalidOptions } from "./email-invalid-options.js";
import type { EmailMessageInput } from "./email-message.js";
import { EmailRejected } from "./email-rejected.js";
import { EmailSender, EmailSenderIdempotencySchema } from "./email-sender.js";
import type { EmailSubmission } from "./email-sender.js";
import { Email, emailLayer } from "./email-service.js";
import { emailRouterLayer } from "./email-routing.js";
import {
  RecordedEmails,
  recordingEmailLayer,
  recordingSenderLayer,
} from "./recording-email-sender.js";

const message: EmailMessageInput = {
  body: { text: "Fictional private body" },
  from: "sender@example.test",
  subject: "Fictional private subject",
  to: "recipient@example.test",
};

const withRecordingDefaults = (defaults: EmailDefaultsInput) =>
  defaultedEmailLayer(recordingEmailLayer, defaults).pipe(Layer.provideMerge(recordingSenderLayer));

const policy = {
  deadline: Duration.seconds(10),
  initialDelay: Duration.millis(100),
  maxAttempts: 2,
};

describe("owned explicit email defaults", () => {
  it.effect(
    "merges intent before validation without sending; per-message values remain explicit",
    () =>
      Effect.gen(function* verifyDefaultsMerging() {
        const email = yield* Email;
        const records = yield* RecordedEmails;

        const prepared = yield* email.validate({
          ...message,
          headers: [{ name: "X-Trace", value: "operation" }],
          metadata: { collision: "operation", operation: "retained" },
          replyTo: "operation@example.test",
          tags: [{ name: "operation", value: "retained" }],
        });

        assert.deepStrictEqual(prepared.headers, [
          { name: "X-Trace", value: "default" },
          { name: "X-Trace", value: "operation" },
        ]);
        assert.deepStrictEqual(prepared.metadata, {
          application: "retained",
          collision: "operation",
          operation: "retained",
        });
        assert.deepStrictEqual(prepared.replyTo?.map(String), ["operation@example.test"]);
        assert.deepStrictEqual(
          prepared.tags?.map(({ name }) => name),
          ["application", "operation"],
        );
        assert.strictEqual((yield* records.messages).length, 0);
        const receipt = yield* email.send(message);
        assert.strictEqual(receipt._tag, "Recorded");
        const [sent] = yield* records.messages;
        assert.isDefined(sent);
        assert.deepStrictEqual(sent.replyTo?.map(String), ["default@example.test"]);
        assert(Object.isFrozen(prepared.headers));
        assert(Object.isFrozen(prepared.metadata));
        assert(Object.isFrozen(sent));
      }).pipe(
        Effect.provide(
          withRecordingDefaults({
            headers: [{ name: "X-Trace", value: "default" }],
            metadata: { application: "retained", collision: "default" },
            replyTo: "default@example.test",
            tags: [{ name: "application", value: "retained" }],
          }),
        ),
      ),
  );

  it.effect(
    "composes ordered defaults once per send and previews the complete effective message",
    () =>
      Effect.gen(function* verifyNestedDefaults() {
        const inner = defaultedEmailLayer(recordingEmailLayer, {
          headers: [{ name: "X-Layer", value: "inner" }],
          metadata: { layer: "inner" },
        });

        const app = Effect.gen(function* inspectNestedDefaults() {
          const email = yield* Email;
          const preview = yield* email.validate(message);
          yield* email.send(message);
          const [sent] = yield* (yield* RecordedEmails).messages;
          assert.isDefined(sent);
          assert.deepStrictEqual(sent, preview);
          assert.deepStrictEqual(
            sent.headers?.map(({ value }) => value),
            ["inner", "outer"],
          );
          assert.strictEqual(sent.metadata?.layer, "outer");
        });

        yield* app.pipe(
          Effect.provide(
            defaultedEmailLayer(inner, {
              headers: [{ name: "X-Layer", value: "outer" }],
              metadata: { layer: "outer" },
            }).pipe(Layer.provideMerge(recordingSenderLayer)),
          ),
        );
      }),
  );

  it.effect("owns configuration without freezing caller state or accepting later mutation", () =>
    Effect.gen(function* verifyDefaultsOwnership() {
      const defaults = {
        headers: [{ name: "X-App", value: "original-private-header" }],
        metadata: { app: "original-private-metadata" },
        replyTo: { address: "original@example.test", name: "Original" },
        tags: [{ name: "app", value: "original-private-tag" }],
      } satisfies EmailDefaultsInput;

      const app = Effect.gen(function* mutateCallerDefaults() {
        const email = yield* Email;
        Reflect.set(defaults.headers[0] ?? {}, "value", "changed");
        defaults.metadata.app = "changed";
        defaults.replyTo.address = "changed@example.test";
        Reflect.set(defaults.tags[0] ?? {}, "value", "changed");
        const prepared = yield* email.validate(message);
        assert.strictEqual(defaults.metadata.app, "changed");
        assert.strictEqual(prepared.headers?.[0].value, "original-private-header");
        assert.strictEqual(prepared.metadata?.app, "original-private-metadata");
        assert.strictEqual(prepared.tags?.[0].value, "original-private-tag");
        assert.deepStrictEqual(prepared.replyTo?.map(formatEmailMailbox), [
          '"Original" <original@example.test>',
        ]);
      });

      yield* app.pipe(Effect.provide(withRecordingDefaults(defaults)));
    }),
  );

  it.effect(
    "refuses invalid defaults before acquiring the supplied Layer and sanitizes failures",
    () =>
      Effect.gen(function* verifyDefaultsAcquisitionFence() {
        const acquisitions = yield* Ref.make(0);
        const lifecycle = Layer.effectDiscard(Ref.update(acquisitions, (count) => count + 1));
        const defaults = { idempotencyKeyPrefix: "private-prefix/" };
        Reflect.set(defaults, "private-unrecognized-field", "private-value");

        const result = yield* Effect.result(
          Email.pipe(
            Effect.provide(
              defaultedEmailLayer(recordingEmailLayer.pipe(Layer.provide(lifecycle)), defaults),
            ),
          ),
        );

        assert(Result.isFailure(result));
        assert(result.failure instanceof EmailConfigurationError);
        assert.strictEqual(yield* Ref.get(acquisitions), 0);
        assert.notInclude(JSON.stringify(result.failure), "private-value");
        assert.notInclude(JSON.stringify(result.failure), "private-unrecognized-field");
      }),
  );

  it.effect.each([
    { input: { ...message, tags: [{ name: "app", value: "operation" }] as const } },
    {
      input: {
        ...message,
        headers: [
          { name: "X-Operation", value: "bounded" },
          ...Array.from({ length: 63 }, () => ({ name: "X-Operation", value: "bounded" })),
        ] as const,
      },
    },
    {
      input: {
        ...message,
        metadata: Object.fromEntries(
          Array.from({ length: 32 }, (_, index) => [`operation-${index}`, "bounded"]),
        ),
      },
    },
  ])("rejects conflicting or over-budget merged intent without submission", ({ input }) =>
    Effect.gen(function* verifyMergedDefaultsBudgets() {
      const email = yield* Email;
      const result = yield* Effect.result(email.send(input));
      assert(Result.isFailure(result));
      assert(result.failure instanceof EmailInvalidMessage);
      assert.strictEqual((yield* (yield* RecordedEmails).messages).length, 0);
    }).pipe(
      Effect.provide(
        withRecordingDefaults({
          headers: [{ name: "X-App", value: "default" }],
          metadata: { app: "default" },
          tags: [{ name: "app", value: "default" }],
        }),
      ),
    ),
  );

  it.effect(
    "settles invalid batch envelopes per item and applies defaults to personalized messages",
    () =>
      Effect.gen(function* verifyDefaultedBatchContracts() {
        const email = yield* Email;
        const invalid = { message, options: { idempotencyKey: "invalid" } };
        Reflect.set(invalid, "private-extra", "never-retained");
        const results = yield* email.sendAll([invalid, { message }], { concurrency: 1 });
        const [failed, accepted] = results;
        assert.isDefined(failed);
        assert(Result.isFailure(failed));
        assert(failed.failure instanceof EmailInvalidOptions);
        assert.isDefined(accepted);
        assert(Result.isSuccess(accepted));

        const personalized = yield* email.sendPersonalized({
          message: {
            body: { text: "Hello %recipient.name%" },
            from: message.from,
            subject: "Hello %recipient.name%",
          },
          recipients: [
            { idempotencyKey: "one", to: "one@example.test", variables: { name: "One" } },
            { idempotencyKey: "two", to: "two@example.test", variables: { name: "Two" } },
          ],
        });

        assert(personalized.every(Result.isSuccess));
        const sent = yield* (yield* RecordedEmails).messages;
        assert.deepStrictEqual(
          sent.map((entry) => entry.subject),
          [message.subject, "Hello One", "Hello Two"],
        );
        assert(sent.every((entry) => entry.headers?.[0].value === "default"));
      }).pipe(
        Effect.provide(
          withRecordingDefaults({
            headers: [{ name: "X-App", value: "default" }],
            idempotencyKeyPrefix: "application/",
          }),
        ),
      ),
  );

  it.effect.prop(
    "keeps distinct logical keys distinct even when a caller key already begins with the prefix",
    { suffix: Schema.String.check(Schema.isPattern(/^[a-z]{1,12}$/u)) },
    ({ suffix }) =>
      Effect.gen(function* verifyPrefixIdentity() {
        const email = yield* Email;
        const first = yield* email.send(message, { idempotencyKey: suffix });
        const replay = yield* email.send(message, { idempotencyKey: suffix });
        assert.deepStrictEqual(first, replay);
        yield* email.send(
          { ...message, subject: "A different logical message" },
          { idempotencyKey: `application/${suffix}` },
        );
        assert.strictEqual((yield* (yield* RecordedEmails).messages).length, 2);
      }).pipe(Effect.provide(withRecordingDefaults({ idempotencyKeyPrefix: "application/" }))),
    { arbitrary: { runs: 12 } },
  );

  it.effect("never generates a shared key and rejects an oversized effective key locally", () =>
    Effect.gen(function* verifyEffectiveDefaultKey() {
      const email = yield* Email;
      yield* email.send(message);
      yield* email.send(message);
      const result = yield* Effect.result(email.send(message, { idempotencyKey: "x".repeat(256) }));
      assert(Result.isFailure(result));
      assert(result.failure instanceof EmailInvalidOptions);
      assert.strictEqual((yield* (yield* RecordedEmails).messages).length, 2);
    }).pipe(Effect.provide(withRecordingDefaults({ idempotencyKeyPrefix: "application/" }))),
  );

  it.effect(
    "preflights effective defaults and keys across every route before primary submission",
    () =>
      Effect.gen(function* verifyRoutedDefaultsPreflight() {
        const shortSender = Layer.effect(
          EmailSender,
          Effect.gen(function* restrictFixtureKeys() {
            const sender = yield* EmailSender;

            return EmailSender.of({
              ...sender,
              idempotency: EmailSenderIdempotencySchema.cases.Native.make({
                maxKeyLength: 5,
                retention: Duration.hours(24),
              }),
            });
          }),
        ).pipe(Layer.provide(recordingSenderLayer));

        const routed = emailRouterLayer(
          [
            { layer: recordingEmailLayer, name: "primary" },
            { layer: emailLayer().pipe(Layer.provide(shortSender)), name: "backup" },
          ],
          { fallbacks: ["backup"], primary: "primary" },
        );

        const app = Effect.gen(function* sendThroughDefaultedRouter() {
          const result = yield* Effect.result(
            (yield* Email).send(message, { idempotencyKey: "one" }),
          );

          assert(Result.isFailure(result));
          assert(result.failure instanceof EmailRejected);
          assert.strictEqual(result.failure.reason, "unsupported-idempotency");
          assert.strictEqual((yield* (yield* RecordedEmails).messages).length, 0);
        });

        yield* app.pipe(
          Effect.provide(
            defaultedEmailLayer(routed, { idempotencyKeyPrefix: "application/" }).pipe(
              Layer.provideMerge(recordingSenderLayer),
            ),
          ),
        );
      }),
  );

  it.effect(
    "preserves one merged intent and key across rejection retry and excludes private data from spans",
    () =>
      Effect.gen(function* verifyDefaultRetryOwnership() {
        const calls = yield* Queue.unbounded<EmailSubmission>();
        const attempts = yield* Ref.make(0);

        const sender = Layer.effect(
          EmailSender,
          Effect.gen(function* acquireRetryingFixtureSender() {
            const recording = yield* EmailSender;

            return EmailSender.of({
              ...recording,
              submit: Effect.fnUntraced(function* retryingFixtureSubmission(
                submission: EmailSubmission,
              ) {
                yield* Queue.offer(calls, submission);
                const count = yield* Ref.updateAndGet(attempts, (value) => value + 1);

                return count === 1
                  ? yield* new EmailRejected({
                      provider: "fixture",
                      reason: "temporarily-unavailable",
                    })
                  : yield* recording.submit(submission);
              }),
            });
          }),
        ).pipe(Layer.provide(recordingSenderLayer));

        const defaults = {
          headers: [{ name: "X-Private", value: "private-default-header" }],
          idempotencyKeyPrefix: "private-prefix/",
        } satisfies EmailDefaultsInput;

        const trace = yield* startEmailTraceFixture();
        const input = { ...message };
        const options = { idempotencyKey: "private-event-key" };

        const app = Effect.gen(function* executeOwnedDefaultRetry() {
          const fiber = yield* (yield* Email).send(input, options).pipe(Effect.forkScoped);
          const first = yield* Queue.take(calls);
          input.subject = "changed";
          options.idempotencyKey = "changed";
          defaults.idempotencyKeyPrefix = "changed/";
          Reflect.set(defaults.headers[0] ?? {}, "value", "changed");
          yield* TestClock.adjust("1 second");
          yield* Fiber.join(fiber);
          const second = yield* Queue.take(calls);
          assert.strictEqual(first.idempotencyKey, "private-prefix/private-event-key");
          assert.deepStrictEqual(second, first);
          assert.strictEqual(second.message.headers?.length, 1);
        });

        yield* app.pipe(
          Effect.provide(
            defaultedEmailLayer(emailLayer(policy).pipe(Layer.provide(sender)), defaults),
          ),
          Effect.withTracer(trace.tracer),
        );
        const diagnostics = yield* trace.diagnostics;

        for (const value of [
          message.subject,
          "private-default-header",
          "private-prefix",
          "private-event-key",
          "recipient@example.test",
        ]) {
          assert.notInclude(diagnostics, value);
        }
      }).pipe(Effect.scoped),
  );

  it.effect("preserves base acquisition failure identity", () =>
    Effect.gen(function* verifyDefaultAcquisitionFailure() {
      const failure = new EmailConfigurationError({
        issues: [{ path: "apiKey", problem: "fixture acquisition refused" }],
      });

      const base = Layer.effect(Email, Effect.fail(failure));

      const result = yield* Effect.result(
        Email.pipe(Effect.provide(defaultedEmailLayer(base, {}))),
      );

      assert(Result.isFailure(result));
      assert.strictEqual(result.failure, failure);
    }),
  );

  it.effect("keeps one acquired base lifetime and releases it when the wrapper scope ends", () =>
    Effect.gen(function* verifyDefaultedLayerLifetime() {
      const acquisitions = yield* Ref.make(0);
      const releases = yield* Ref.make(0);

      const lifecycle = Layer.effectDiscard(
        Effect.acquireRelease(
          Ref.update(acquisitions, (count) => count + 1),
          () => Ref.update(releases, (count) => count + 1),
        ),
      );

      const base = recordingEmailLayer.pipe(Layer.provide(lifecycle));

      const app = Effect.gen(function* useDefaultedLayerScope() {
        const email = yield* Email;
        yield* email.send(message, { idempotencyKey: "one" });
        yield* email.send(message, { idempotencyKey: "one" });
        assert.strictEqual(yield* Ref.get(acquisitions), 1);
        assert.strictEqual(yield* Ref.get(releases), 0);
      });

      yield* app.pipe(Effect.provide(defaultedEmailLayer(base, {})));
      assert.strictEqual(yield* Ref.get(releases), 1);
    }),
  );

  it.effect.each(["Interrupt", "Defect", "Unknown"] as const)(
    "preserves %s without replay or fabricated success",
    (mode) =>
      Effect.gen(function* verifyDefaultFailureTransparency() {
        const entered = yield* Deferred.make<boolean>();
        const calls = yield* Ref.make(0);

        const senderLayer = Layer.effect(
          EmailSender,
          Effect.gen(function* acquireFailingSender() {
            const sender = yield* EmailSender;

            const outcomes = {
              Defect: Effect.die("private-defect"),
              Interrupt: Effect.never,
              Unknown: Effect.fail(
                new EmailDeliveryUnknown({ provider: "fixture", reason: "transport" }),
              ),
            };

            return EmailSender.of({
              ...sender,
              idempotency: EmailSenderIdempotencySchema.cases.None.make({}),
              submit: () =>
                Ref.update(calls, (count) => count + 1).pipe(
                  Effect.andThen(Deferred.succeed(entered, true)),
                  Effect.andThen(outcomes[mode]),
                ),
            });
          }),
        ).pipe(Layer.provide(recordingSenderLayer));

        const base = emailLayer().pipe(Layer.provide(senderLayer));

        const app = Effect.gen(function* invokeDefaultedFailure() {
          const fiber = yield* (yield* Email).send(message).pipe(Effect.forkScoped);
          yield* Deferred.await(entered);

          if (mode === "Interrupt") {
            yield* Fiber.interrupt(fiber);
          }

          const exit = yield* Fiber.await(fiber);
          assert(Exit.isFailure(exit));
          assert.strictEqual(Exit.hasInterrupts(exit), mode === "Interrupt");
          assert.strictEqual(Exit.hasDies(exit), mode === "Defect");
          assert.strictEqual(yield* Ref.get(calls), 1);
        });

        yield* app.pipe(
          Effect.provide(
            defaultedEmailLayer(base, { headers: [{ name: "X-App", value: "default" }] }),
          ),
        );
      }).pipe(Effect.scoped),
  );
});
