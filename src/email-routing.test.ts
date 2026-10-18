import { assert, describe, it } from "@effect/vitest";
import {
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Queue,
  Ref,
  Result,
  Schema,
} from "effect";
import { TestClock } from "effect/testing";
import {
  Email,
  EmailConfigurationError,
  EmailDeliveryUnknown,
  EmailInvalidMessage,
  EmailInvalidOptions,
  EmailReceiptSchema,
  EmailRejected,
  EmailRouter,
  EmailSender,
  EmailSenderIdempotencySchema,
  emailLayer,
  emailRouterLayer,
} from "./index.js";
import type {
  EmailMessageInput,
  EmailSendOptionsInput,
  EmailSenderCapabilities,
  EmailSenderIdempotency,
  EmailSubmission,
  EmailSubmissionError,
} from "./index.js";
import { recordingEmailCapabilities, recordingEmailLayer } from "./recording-email-sender.js";

const message: EmailMessageInput = {
  body: { text: "Fictional routing notification." },
  from: "sender@example.test",
  subject: "Synthetic routing",
  to: "recipient@example.test",
};

const receipt = EmailReceiptSchema.cases.Recorded.make({ sequence: 1 });

const native = EmailSenderIdempotencySchema.cases.Native.make({ retention: Duration.hours(24) });

const noIdempotency = EmailSenderIdempotencySchema.cases.None.make({});

const policy = {
  deadline: Duration.seconds(20),
  initialDelay: Duration.millis(100),
  maxAttempts: 1,
};

const routeLayer = (
  submit: (submission: EmailSubmission) => Effect.Effect<typeof receipt, EmailSubmissionError>,
  idempotency: EmailSenderIdempotency = noIdempotency,
  capabilities: EmailSenderCapabilities = recordingEmailCapabilities,
) =>
  emailLayer(policy).pipe(
    Layer.provide(
      Layer.succeed(EmailSender, {
        capabilities,
        idempotency,
        provider: "synthetic",
        submit,
        validate: () => Effect.void,
      }),
    ),
  );

const rejected = (reason: EmailRejected["reason"]) =>
  new EmailRejected({ provider: "synthetic", reason });

const routerProgram = Effect.gen(function* useDefaultRoute() {
  const router = yield* EmailRouter;

  return yield* router.select();
});

const provideRouterInTestScope =
  <E, R>(layer: Layer.Layer<EmailRouter | Email, E, R>) =>
  (effect: typeof routerProgram) =>
    Layer.build(layer).pipe(
      Effect.flatMap((context) =>
        effect.pipe(Effect.provideService(EmailRouter, Context.get(context, EmailRouter))),
      ),
    );

describe("Named routing and submission evidence", () => {
  it.effect("selects a named account and stops the route chain after acceptance", () =>
    Effect.gen(function* selectAccount() {
      const calls = yield* Ref.make<readonly string[]>([]);

      const primary = routeLayer(() =>
        Ref.update(calls, (observed) => [...observed, "primary"]).pipe(Effect.as(receipt)),
      );

      const secondary = routeLayer(() =>
        Ref.update(calls, (observed) => [...observed, "secondary"]).pipe(Effect.as(receipt)),
      );

      const app = Effect.gen(function* inspectNamedRoutes() {
        const router = yield* EmailRouter;
        const selected = yield* router.select({ primary: "secondary" });
        const selectedReceipt = yield* selected.send(message);
        assert.strictEqual(selectedReceipt.route, "secondary");
        Reflect.set(selectedReceipt, "route", "primary");
        assert.strictEqual(selectedReceipt.route, "secondary");
        const defaultReceipt = yield* (yield* Email).send(message);
        assert(EmailReceiptSchema.guards.Recorded(defaultReceipt));
        assert.deepStrictEqual(yield* Ref.get(calls), ["secondary", "primary"]);
        assert.strictEqual(router.routes.length, 2);
      });

      yield* app.pipe(
        Effect.provide(
          emailRouterLayer(
            [
              { layer: primary, name: "primary" },
              { layer: secondary, name: "secondary" },
            ],
            { fallbacks: ["secondary"], primary: "primary" },
          ),
        ),
      );
    }),
  );

  it.effect.each(["authentication", "invalid-message", "rejected", "rate-limited"] as const)(
    "falls back after definite $0 non-acceptance and reports the accepting account",
    (reason) =>
      Effect.gen(function* fallbackAfterRejection() {
        const calls = yield* Ref.make<readonly string[]>([]);

        const primary = routeLayer(() =>
          Ref.update(calls, (observed) => [...observed, "primary"]).pipe(
            Effect.andThen(Effect.fail(rejected(reason))),
          ),
        );

        const secondary = routeLayer(() =>
          Ref.update(calls, (observed) => [...observed, "secondary"]).pipe(Effect.as(receipt)),
        );

        const routed = yield* routerProgram.pipe(
          provideRouterInTestScope(
            emailRouterLayer(
              [
                { layer: primary, name: "primary" },
                { layer: secondary, name: "secondary" },
              ],
              { fallbacks: ["secondary"], primary: "primary" },
            ),
          ),
        );

        const accepted = yield* routed.send(message);
        assert.strictEqual(accepted.route, "secondary");
        assert.deepStrictEqual(yield* Ref.get(calls), ["primary", "secondary"]);
      }),
  );

  it.effect.each([
    new EmailDeliveryUnknown({ provider: "synthetic", reason: "server-error" }),
    new EmailDeliveryUnknown({ provider: "synthetic", reason: "invalid-response" }),
    rejected("idempotency-conflict"),
    rejected("unsupported-idempotency"),
  ])("does not cross accounts after uncertain or conflicting submission evidence $0", (failure) =>
    Effect.gen(function* preserveAccountAuthority() {
      const fallbackCalls = yield* Ref.make(0);

      const routed = yield* routerProgram.pipe(
        provideRouterInTestScope(
          emailRouterLayer(
            [
              { layer: routeLayer(() => Effect.fail(failure), native), name: "primary" },
              {
                layer: routeLayer(
                  () => Ref.update(fallbackCalls, (count) => count + 1).pipe(Effect.as(receipt)),
                  native,
                ),
                name: "secondary",
              },
            ],
            { fallbacks: ["secondary"], primary: "primary" },
          ),
        ),
      );

      const observed = yield* routed
        .send(message, { idempotencyKey: "event/routed" })
        .pipe(Effect.flip);

      assert.strictEqual(observed, failure);
      assert.strictEqual(yield* Ref.get(fallbackCalls), 0);
    }),
  );

  it.effect.each([rejected("authentication"), rejected("temporarily-unavailable")])(
    "preserves prior uncertainty when a native retry later rejects $0",
    (laterRejection) =>
      Effect.gen(function* preserveUncertaintyAcrossRetryRejection() {
        const calls = yield* Ref.make(0);
        const attempts = yield* Queue.unbounded<number>();
        const fallbackCalls = yield* Ref.make(0);

        const uncertain = new EmailDeliveryUnknown({
          provider: "synthetic",
          reason: "server-error",
        });

        const routed = yield* routerProgram.pipe(
          provideRouterInTestScope(
            emailRouterLayer(
              [
                {
                  layer: routeLayer(
                    () =>
                      Ref.updateAndGet(calls, (count) => count + 1).pipe(
                        Effect.tap((attempt) => Queue.offer(attempts, attempt)),
                        Effect.flatMap((attempt) =>
                          Effect.fail(attempt === 1 ? uncertain : laterRejection),
                        ),
                      ),
                    native,
                  ),
                  name: "primary",
                },
                {
                  layer: routeLayer(
                    () => Ref.update(fallbackCalls, (count) => count + 1).pipe(Effect.as(receipt)),
                    native,
                  ),
                  name: "secondary",
                },
              ],
              { fallbacks: ["secondary"], primary: "primary" },
            ),
          ),
        );

        const fiber = yield* routed
          .send(message, {
            idempotencyKey: "event/uncertain-before-rejection",
            policy: { ...policy, maxAttempts: 2 },
          })
          .pipe(Effect.result, Effect.forkScoped);

        assert.strictEqual(yield* Queue.take(attempts), 1);
        yield* TestClock.adjust("1 second");
        const result = yield* Fiber.join(fiber);
        assert(Result.isFailure(result));
        assert.strictEqual(result.failure, uncertain);
        assert.strictEqual(yield* Ref.get(calls), 2);
        assert.strictEqual(yield* Ref.get(fallbackCalls), 0);
      }),
  );

  it.effect(
    "preflights every selected route before submission without discarding keys or rich intent",
    () =>
      Effect.gen(function* preflightWholeRoute() {
        const calls = yield* Ref.make(0);
        const submit = () => Ref.update(calls, (count) => count + 1).pipe(Effect.as(receipt));

        const routed = yield* routerProgram.pipe(
          provideRouterInTestScope(
            emailRouterLayer(
              [
                { layer: routeLayer(submit, native), name: "primary" },
                {
                  layer: routeLayer(submit, noIdempotency, {
                    ...recordingEmailCapabilities,
                    metadata: false,
                  }),
                  name: "secondary",
                },
              ],
              { fallbacks: ["secondary"], primary: "primary" },
            ),
          ),
        );

        const validation = yield* routed.validate(message);
        assert.strictEqual(validation.subject, message.subject);

        const unsupported = yield* routed
          .send({ ...message, metadata: { workflow: "private-value" } })
          .pipe(Effect.flip);

        assert(Schema.is(EmailInvalidMessage)(unsupported));
        assert.notInclude(JSON.stringify(unsupported), "private-value");

        const keyed = yield* routed
          .send(message, { idempotencyKey: "private-key" })
          .pipe(Effect.flip);

        assert(Schema.is(EmailRejected)(keyed));
        assert.strictEqual(keyed.reason, "unsupported-idempotency");
        assert.strictEqual(routed.capabilities.metadata, false);
        Reflect.set(routed.capabilities, "metadata", true);
        assert.strictEqual(routed.capabilities.metadata, false);
        assert.strictEqual(yield* Ref.get(calls), 0);
      }),
  );

  it.effect("owns selected plans, messages, and policies while waiting for a fallback", () =>
    Effect.gen(function* preservePreparedRouting() {
      const ready = yield* Deferred.make<boolean>();
      const rejectPrimary = yield* Deferred.make<boolean>();
      const observed = yield* Queue.unbounded<EmailSubmission>();
      const secondaryAttempts = yield* Ref.make(0);
      const plan = { fallbacks: ["secondary"], primary: "primary" } as const;
      const source = { ...message, body: { text: "Original fictional content." } };
      const operationPolicy = { ...policy, maxAttempts: 2 };

      const options: EmailSendOptionsInput = {
        idempotencyKey: "event/original",
        policy: operationPolicy,
      };

      const app = Effect.gen(function* submitOwnedRoute() {
        const routed = yield* (yield* EmailRouter).select(plan);
        Reflect.set(plan.fallbacks, "0", "primary");
        const fiber = yield* routed.send(source, options).pipe(Effect.forkScoped);
        yield* Deferred.await(ready);
        source.body.text = "Changed private content.";
        Reflect.set(options, "idempotencyKey", "event/changed");
        operationPolicy.maxAttempts = 1;
        yield* Deferred.succeed(rejectPrimary, true);
        yield* TestClock.adjust("1 second");
        const accepted = yield* Fiber.join(fiber);
        const submission = yield* Queue.take(observed);
        assert.strictEqual(accepted.route, "secondary");
        assert.strictEqual(submission.message.body.text, "Original fictional content.");
        assert.strictEqual(submission.idempotencyKey, "event/original");
        assert.deepStrictEqual(yield* Queue.take(observed), submission);
        assert.strictEqual(yield* Ref.get(secondaryAttempts), 2);
      });

      yield* app.pipe(
        Effect.provide(
          emailRouterLayer(
            [
              {
                layer: routeLayer(
                  () =>
                    Deferred.succeed(ready, true).pipe(
                      Effect.andThen(Deferred.await(rejectPrimary)),
                      Effect.andThen(Effect.fail(rejected("authentication"))),
                    ),
                  native,
                ),
                name: "primary",
              },
              {
                layer: routeLayer(
                  Effect.fnUntraced(function* submitSecondaryAccount(submission: EmailSubmission) {
                    yield* Queue.offer(observed, submission);

                    const attempt = yield* Ref.updateAndGet(
                      secondaryAttempts,
                      (count) => count + 1,
                    );

                    return attempt === 1
                      ? yield* new EmailDeliveryUnknown({
                          provider: "synthetic",
                          reason: "server-error",
                        })
                      : receipt;
                  }),
                  native,
                ),
                name: "secondary",
              },
            ],
            { primary: "primary" },
          ),
        ),
      );
    }),
  );

  it.effect("enforces one total deadline across accounts and interrupts the active fallback", () =>
    Effect.gen(function* boundWholeRoute() {
      const started = yield* Deferred.make<boolean>();
      const finalized = yield* Deferred.make<boolean>();

      const app = Effect.gen(function* expireRoute() {
        const routed = yield* (yield* EmailRouter).select({
          deadline: Duration.seconds(5),
          fallbacks: ["secondary"],
          primary: "primary",
        });

        const fiber = yield* routed.send(message).pipe(Effect.result, Effect.forkScoped);
        yield* TestClock.adjust("2 seconds");
        yield* Deferred.await(started);
        yield* TestClock.adjust("3 seconds");
        const result = yield* Fiber.join(fiber);
        assert(Result.isFailure(result));
        assert(Schema.is(EmailDeliveryUnknown)(result.failure));
        assert.strictEqual(result.failure.reason, "timeout");
        assert.strictEqual(result.failure.provider, "email-router");
        assert.strictEqual(yield* Deferred.await(finalized), true);
      });

      yield* app.pipe(
        Effect.provide(
          emailRouterLayer(
            [
              {
                layer: routeLayer(() =>
                  Effect.sleep("2 seconds").pipe(
                    Effect.andThen(Effect.fail(rejected("authentication"))),
                  ),
                ),
                name: "primary",
              },
              {
                layer: routeLayer(() =>
                  Deferred.succeed(started, true).pipe(
                    Effect.andThen(Effect.never),
                    Effect.ensuring(Deferred.succeed(finalized, true)),
                  ),
                ),
                name: "secondary",
              },
            ],
            { primary: "primary" },
          ),
        ),
      );
    }),
  );

  it.effect("propagates defects and interruption without treating them as fallback evidence", () =>
    Effect.gen(function* preserveRoutingCauses() {
      const fallbackCalls = yield* Ref.make(0);
      const ready = yield* Deferred.make<boolean>();
      const cancelled = yield* Deferred.make<boolean>();

      const backup = routeLayer(() =>
        Ref.update(fallbackCalls, (count) => count + 1).pipe(Effect.as(receipt)),
      );

      const app = Effect.gen(function* inspectCauses() {
        const router = yield* EmailRouter;
        const defectRoute = yield* router.select({ fallbacks: ["secondary"], primary: "defect" });
        assert(Exit.hasDies(yield* defectRoute.send(message).pipe(Effect.exit)));
        const pendingRoute = yield* router.select({ fallbacks: ["secondary"], primary: "pending" });
        const fiber = yield* pendingRoute.send(message).pipe(Effect.forkScoped);
        yield* Deferred.await(ready);
        yield* Fiber.interrupt(fiber);
        assert(Exit.hasInterrupts(yield* Fiber.await(fiber)));
        assert.strictEqual(yield* Deferred.await(cancelled), true);
        assert.strictEqual(yield* Ref.get(fallbackCalls), 0);
      });

      yield* app.pipe(
        Effect.provide(
          emailRouterLayer(
            [
              { layer: routeLayer(() => Effect.die("synthetic observer defect")), name: "defect" },
              {
                layer: routeLayer(() =>
                  Deferred.succeed(ready, true).pipe(
                    Effect.andThen(Effect.never),
                    Effect.ensuring(Deferred.succeed(cancelled, true)),
                  ),
                ),
                name: "pending",
              },
              { layer: backup, name: "secondary" },
            ],
            { primary: "defect" },
          ),
        ),
      );
    }),
  );

  it.effect(
    "settles routed batches and personalization in order while keeping invalid items local",
    () =>
      Effect.gen(function* settleRoutedOperations() {
        const received = yield* Ref.make<readonly string[]>([]);

        const submit = (submission: EmailSubmission) =>
          Ref.update(received, (subjects) => [...subjects, submission.message.subject]).pipe(
            Effect.as(receipt),
          );

        const routed = yield* routerProgram.pipe(
          provideRouterInTestScope(
            emailRouterLayer(
              [
                {
                  layer: routeLayer(() => Effect.fail(rejected("authentication"))),
                  name: "primary",
                },
                { layer: routeLayer(submit), name: "secondary" },
              ],
              { fallbacks: ["secondary"], primary: "primary" },
            ),
          ),
        );

        const results = yield* routed.sendAll(
          [
            { message },
            {
              message: {
                ...message,
                metadata: { private: "safe synthetic" },
                subject: "Bad\nsubject",
              },
            },
            { message: { ...message, subject: "Another synthetic notification" } },
          ],
          { concurrency: 1 },
        );

        assert.strictEqual(results.length, 3);
        const [first, invalid, last] = results;
        assert(first !== undefined && Result.isSuccess(first));
        assert(last !== undefined && Result.isSuccess(last));
        assert.strictEqual(first.success.route, "secondary");
        assert.strictEqual(last.success.route, "secondary");
        assert(invalid !== undefined && Result.isFailure(invalid));
        assert(Schema.is(EmailInvalidMessage)(invalid.failure));
        assert(invalid.failure.issues.some((issue) => issue.path === "message.subject"));

        const personalized = yield* routed.sendPersonalized(
          {
            message: {
              body: { text: "%recipient.name%" },
              from: "sender@example.test",
              subject: "Hello %recipient.name%",
            },
            recipients: [
              { to: "first@example.test", variables: { name: "First" } },
              { to: "invalid@example.test", variables: {} },
              { to: "last@example.test", variables: { name: "Last" } },
            ],
          },
          { concurrency: 1 },
        );

        assert(personalized[0] !== undefined && Result.isSuccess(personalized[0]));
        assert.strictEqual(personalized[0].success.route, "secondary");
        assert(personalized[1] !== undefined && Result.isFailure(personalized[1]));
        assert(personalized[2] !== undefined && Result.isSuccess(personalized[2]));
        assert.deepStrictEqual(yield* Ref.get(received), [
          message.subject,
          "Another synthetic notification",
          "Hello First",
          "Hello Last",
        ]);
      }),
  );

  it.effect(
    "fails invalid defaults before acquiring resources and rejects unknown operation routes safely",
    () =>
      Effect.gen(function* rejectInvalidRouting() {
        const acquisitions = yield* Ref.make(0);
        const releases = yield* Ref.make(0);

        const acquired = Layer.effectDiscard(
          Effect.acquireRelease(
            Ref.update(acquisitions, (count) => count + 1),
            () => Ref.update(releases, (count) => count + 1),
          ),
        );

        const scopedRoute = recordingEmailLayer.pipe(Layer.provide(acquired));

        const invalid = yield* routerProgram.pipe(
          Effect.provide(
            emailRouterLayer([{ layer: scopedRoute, name: "primary" }], { primary: "missing" }),
          ),
          Effect.flip,
        );

        assert(Schema.is(EmailConfigurationError)(invalid));
        assert.strictEqual(yield* Ref.get(acquisitions), 0);

        const app = Effect.gen(function* rejectUnregisteredSelection() {
          const router = yield* EmailRouter;
          const failure = yield* router.select({ primary: "private-route" }).pipe(Effect.flip);
          assert(Schema.is(EmailInvalidOptions)(failure));
          assert.notInclude(JSON.stringify(failure), "private-route");

          const duplicate = yield* router
            .select({ fallbacks: ["primary"], primary: "primary" })
            .pipe(Effect.flip);

          assert(Schema.is(EmailInvalidOptions)(duplicate));
        });

        yield* app.pipe(
          Effect.provide(
            emailRouterLayer([{ layer: scopedRoute, name: "primary" }], { primary: "primary" }),
          ),
        );
        assert.strictEqual(yield* Ref.get(acquisitions), 1);
        assert.strictEqual(yield* Ref.get(releases), 1);
      }),
  );
});
