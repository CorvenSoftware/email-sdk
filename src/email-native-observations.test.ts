import { assert, describe, it } from "@effect/vitest";
import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Exit,
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
import { EmailConfigurationError } from "./email-configuration-error.js";
import { EmailDeliveryUnknown } from "./email-delivery-unknown.js";
import type { EmailSendError } from "./email-errors.js";
import { EmailInvalidMessage } from "./email-invalid-message.js";
import { EmailInvalidOptions } from "./email-invalid-options.js";
import { EmailMessageIdSchema, EmailReceiptSchema } from "./email-message.js";
import type { EmailReceipt } from "./email-message.js";
import {
  EmailNativeObservations,
  EmailNativeObservationSchema,
  EmailNativeOperationStartingSchema,
  observedIterableCampaignLayer,
  observedLoopsTransactionalLayer,
} from "./email-native-observations.js";
import type {
  EmailNativeOperationStarting,
  EmailNativeStartingObserver,
} from "./email-native-observations.js";
import { EmailRejected } from "./email-rejected.js";
import { defaultedIterableCampaignLayer } from "./iterable-campaign-defaults.js";
import { IterableCampaignEmail, iterableCampaignLayer } from "./iterable-campaign-email.js";
import { defaultedLoopsTransactionalLayer } from "./loops-transactional-defaults.js";
import { LoopsTransactionalEmail, loopsTransactionalLayer } from "./loops-transactional-email.js";

const loopsJob = {
  email: "recipient@fictional.invalid",
  transactionalId: "private_template",
} as const;

const iterableJob = { campaignId: 123, recipientEmail: "recipient@fictional.invalid" } as const;

const policy = {
  deadline: Duration.seconds(10),
  initialDelay: Duration.millis(100),
  maxAttempts: 3,
};

const loopsReply = { body: '{"success":true}', status: 200 };

const iterableReply = { body: '{"code":"Success","msg":"private reply"}', status: 200 };

const loopsLayer = (fixture: EmailHttpFixture) =>
  loopsTransactionalLayer(
    {
      apiKey: Redacted.make("private-native-key"),
      attachments: "Disabled",
      templateAuthority: "ProviderManaged",
    },
    policy,
  ).pipe(Layer.provide(emailFixtureClientLayer(fixture.url, "https://app.loops.so")));

const iterableLayer = (fixture: EmailHttpFixture) =>
  iterableCampaignLayer(
    {
      apiKey: Redacted.make("private-native-key"),
      campaignAuthority: "AuthorizeProviderManagedCampaign",
      contactWrites: "AuthorizeProfileCreation",
      dataRetention: "AuthorizePersistedSendData",
      projectIdentity: "EmailBased",
      region: "US",
      tracking: "AuthorizeCampaignTracking",
    },
    policy,
  ).pipe(Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.iterable.com")));

const receipt = Object.freeze(
  EmailReceiptSchema.cases.Accepted.make({
    messageId: EmailMessageIdSchema.make("private-receipt-id"),
    provider: "loops",
  }),
);

const rejected = new EmailRejected({ provider: "loops", reason: "authentication", status: 401 });

const unknown = new EmailDeliveryUnknown({ provider: "loops", reason: "transport" });

const suppliedLoopsLayer = (
  base: Layer.Layer<LoopsTransactionalEmail, EmailConfigurationError>,
  send: (job: typeof loopsJob) => Effect.Effect<EmailReceipt, EmailSendError>,
) =>
  Layer.effect(
    LoopsTransactionalEmail,
    Effect.gen(function* acquireControlledLoops() {
      const native = yield* LoopsTransactionalEmail;

      return LoopsTransactionalEmail.of({ ...native, send: () => send(loopsJob) });
    }),
  ).pipe(Layer.provide(base));

describe("bounded native operation observations", () => {
  it.effect.each(["Loops", "Iterable"] as const)(
    "awaits minimal %s starting facts before owned delegation without adding a policy deadline",
    (kind) =>
      Effect.gen(function* awaitNativeStart() {
        const fixture = yield* startEmailHttpFixture(kind === "Loops" ? loopsReply : iterableReply);
        const entered = yield* Deferred.make<boolean>();
        const release = yield* Deferred.make<boolean>();
        const completed = yield* Ref.make(false);
        const starts: EmailNativeOperationStarting[] = [];

        const inputLoops = {
          email: "recipient@fictional.invalid",
          transactionalId: "private_template",
        };

        const inputIterable = { campaignId: 123, recipientEmail: "recipient@fictional.invalid" };

        const starting: EmailNativeStartingObserver = (fact) =>
          Effect.gen(function* holdNativeStart() {
            starts.push(fact);
            yield* Deferred.succeed(entered, true);
            yield* Deferred.await(release);
          }).pipe(Effect.ensuring(Ref.set(completed, true)));

        const inspect = Effect.fnUntraced(function* inspectNativeStart<R>(
          send: Effect.Effect<EmailReceipt, EmailSendError, R>,
        ) {
          const view = yield* EmailNativeObservations;
          const fiber = yield* send.pipe(Effect.forkScoped);
          yield* Deferred.await(entered);
          yield* TestClock.adjust(Duration.seconds(20));
          assert.isFalse(yield* Ref.get(completed));
          assert.strictEqual(yield* Queue.size(fixture.received), 0);
          assert.strictEqual((yield* view.snapshot).observations.length, 0);
          inputLoops.transactionalId = "private_mutated_template";
          inputIterable.campaignId = 456;
          yield* Deferred.succeed(release, true);
          assert.strictEqual((yield* Fiber.join(fiber))._tag, "Accepted");
          assert.strictEqual((yield* view.snapshot).observations.length, 1);
        });

        yield* kind === "Loops"
          ? inspect(
              LoopsTransactionalEmail.pipe(Effect.flatMap((native) => native.send(inputLoops))),
            ).pipe(
              Effect.provide(
                observedLoopsTransactionalLayer(loopsLayer(fixture), {}, undefined, starting),
              ),
            )
          : inspect(
              IterableCampaignEmail.pipe(Effect.flatMap((native) => native.send(inputIterable))),
            ).pipe(
              Effect.provide(
                observedIterableCampaignLayer(iterableLayer(fixture), {}, undefined, starting),
              ),
            );
        const [fact] = starts;
        assert.isDefined(fact);
        assert.isFrozen(fact);
        yield* Schema.decodeEffect(EmailNativeOperationStartingSchema)(fact);
        assert.strictEqual(
          fact.operation,
          kind === "Loops" ? "LoopsTransactional" : "IterableCampaign",
        );
        assert.strictEqual(starts.length, 1);
        assert.notInclude(JSON.stringify(starts), "private");
        assert.notInclude(JSON.stringify(starts), "fictional.invalid");
        const request = yield* Queue.take(fixture.received);
        assert.include(request.body, kind === "Loops" ? "private_template" : '"campaignId":123');
        assert.notInclude(request.body, "private_mutated_template");
        assert.notInclude(request.body, '"campaignId":456');
      }),
  );

  for (const kind of ["Loops", "Iterable"] as const) {
    it.effect.each(["Defect", "Interruption"] as const)(
      `a starting %s cannot become a settled ${kind} batch item or cause submission`,
      (fault) =>
        Effect.gen(function* preserveNativeStartingFault() {
          const fixture = yield* startEmailHttpFixture(
            kind === "Loops" ? loopsReply : iterableReply,
          );

          const starts = yield* Ref.make(0);
          const settled = yield* Ref.make(0);

          const starting: EmailNativeStartingObserver = () =>
            Ref.update(starts, (count) => count + 1).pipe(
              Effect.andThen(
                fault === "Defect"
                  ? Effect.die("private native starting defect")
                  : Effect.failCause(Cause.interrupt(123)),
              ),
            );

          const observer = () => Ref.update(settled, (count) => count + 1);

          const operation =
            kind === "Loops"
              ? LoopsTransactionalEmail.pipe(
                  Effect.flatMap((native) => native.sendAll([{ job: loopsJob }])),
                  Effect.provide(
                    observedLoopsTransactionalLayer(loopsLayer(fixture), {}, observer, starting),
                  ),
                )
              : IterableCampaignEmail.pipe(
                  Effect.flatMap((native) => native.sendAll([{ job: iterableJob }])),
                  Effect.provide(
                    observedIterableCampaignLayer(iterableLayer(fixture), {}, observer, starting),
                  ),
                );

          const trace = yield* startEmailTraceFixture();
          const outcome = yield* operation.pipe(Effect.withTracer(trace.tracer), Effect.exit);
          assert(Exit.isFailure(outcome));
          assert.isTrue(fault === "Defect" ? Exit.hasDies(outcome) : Exit.hasInterrupts(outcome));
          assert.strictEqual(yield* Ref.get(starts), 1);
          assert.strictEqual(yield* Ref.get(settled), 0);
          assert.strictEqual(yield* Queue.size(fixture.received), 0);
          assert.notInclude(yield* trace.diagnostics, "private native starting defect");
        }),
    );
  }

  it.effect(
    "interrupts a native starting callback without recording settlement or issuing HTTP",
    () =>
      Effect.gen(function* interruptNativeStart() {
        const fixture = yield* startEmailHttpFixture(loopsReply);
        const entered = yield* Deferred.make<boolean>();
        const released = yield* Deferred.make<boolean>();

        const starting: EmailNativeStartingObserver = () =>
          Effect.gen(function* holdCancelledNativeStart() {
            yield* Deferred.succeed(entered, true);

            return yield* Effect.never;
          }).pipe(Effect.ensuring(Deferred.succeed(released, true)));

        yield* Effect.gen(function* cancelNativeStartingObserver() {
          const native = yield* LoopsTransactionalEmail;
          const view = yield* EmailNativeObservations;
          const fiber = yield* native.send(loopsJob).pipe(Effect.forkScoped);
          yield* Deferred.await(entered);
          yield* Fiber.interrupt(fiber);
          yield* Deferred.await(released);
          assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(fiber)));
          assert.strictEqual((yield* view.snapshot).observations.length, 0);
          assert.strictEqual(yield* Queue.size(fixture.received), 0);
        }).pipe(
          Effect.provide(
            observedLoopsTransactionalLayer(loopsLayer(fixture), {}, undefined, starting),
          ),
        );
      }),
  );

  it.effect(
    "does not turn a starting notification into submission proof when scheduling expires during the callback",
    () =>
      Effect.gen(function* expireAfterNativeStart() {
        const fixture = yield* startEmailHttpFixture(iterableReply);
        const entered = yield* Deferred.make<boolean>();
        const release = yield* Deferred.make<boolean>();
        const starts = yield* Ref.make(0);

        const starting: EmailNativeStartingObserver = () =>
          Ref.update(starts, (count) => count + 1).pipe(
            Effect.andThen(Deferred.succeed(entered, true)),
            Effect.andThen(Deferred.await(release)),
          );

        yield* Effect.gen(function* revalidateAfterStartingObserver() {
          const native = yield* IterableCampaignEmail;
          const view = yield* EmailNativeObservations;

          const fiber = yield* native
            .send({ ...iterableJob, sendAt: "1970-01-01T00:00:01Z" })
            .pipe(Effect.forkScoped);

          yield* Deferred.await(entered);
          yield* TestClock.adjust(Duration.seconds(2));
          yield* Deferred.succeed(release, true);
          const result = yield* Fiber.join(fiber).pipe(Effect.result);
          assert(Result.isFailure(result));
          assert(result.failure instanceof EmailInvalidMessage);
          assert.strictEqual(yield* Ref.get(starts), 1);
          assert.strictEqual(yield* Queue.size(fixture.received), 0);
          assert.strictEqual((yield* view.snapshot).observations.length, 0);
        }).pipe(
          Effect.provide(
            observedIterableCampaignLayer(iterableLayer(fixture), {}, undefined, starting),
          ),
        );
      }),
  );

  it.effect("delivers distinct native facts through explicitly bound Effect observers", () =>
    Effect.gen(function* deliverNativeFacts() {
      const delivered = yield* Queue.unbounded<typeof EmailNativeObservationSchema.Type>();

      const observer = (fact: typeof EmailNativeObservationSchema.Type) =>
        Queue.offer(delivered, fact).pipe(Effect.asVoid);

      const loopsFixture = yield* startEmailHttpFixture(loopsReply);
      yield* Effect.gen(function* sendObservedLoopsFact() {
        yield* (yield* LoopsTransactionalEmail).send(loopsJob);
        const fact = yield* Queue.take(delivered);
        assert.strictEqual(fact.operation, "LoopsTransactional");
        assert.isFrozen(fact);
        assert.strictEqual(
          fact,
          (yield* (yield* EmailNativeObservations).snapshot).observations[0],
        );
      }).pipe(
        Effect.provide(observedLoopsTransactionalLayer(loopsLayer(loopsFixture), {}, observer)),
      );
      const iterableFixture = yield* startEmailHttpFixture(iterableReply);
      yield* Effect.gen(function* sendObservedIterableFact() {
        yield* (yield* IterableCampaignEmail).send(iterableJob);
        const fact = yield* Queue.take(delivered);
        assert.strictEqual(fact.operation, "IterableCampaign");
        assert.isFrozen(fact);
        assert.strictEqual(
          fact,
          (yield* (yield* EmailNativeObservations).snapshot).observations[0],
        );
        assert.notInclude(JSON.stringify(fact), "private");
        assert.notInclude(JSON.stringify(fact), "fictional.invalid");
      }).pipe(
        Effect.provide(observedIterableCampaignLayer(iterableLayer(iterableFixture), {}, observer)),
      );
      assert.strictEqual(yield* Queue.size(delivered), 0);
      yield* Queue.take(loopsFixture.received);
      yield* Queue.take(iterableFixture.received);
    }),
  );

  it.effect("retains a native fact before an interruptible callback without resubmitting", () =>
    Effect.gen(function* interruptNativeObserver() {
      const fixture = yield* startEmailHttpFixture(loopsReply);
      const entered = yield* Deferred.make<boolean>();
      const release = yield* Deferred.make<boolean>();
      const calls = yield* Ref.make(0);

      const base = suppliedLoopsLayer(loopsLayer(fixture), () =>
        Ref.update(calls, (count) => count + 1).pipe(Effect.as(receipt)),
      );

      yield* Effect.gen(function* inspectInterruptedNativeObserver() {
        const fiber = yield* (yield* LoopsTransactionalEmail)
          .send(loopsJob)
          .pipe(Effect.forkScoped);

        yield* Deferred.await(entered);
        assert.strictEqual(
          (yield* (yield* EmailNativeObservations).snapshot).observations[0]?._tag,
          "Receipt",
        );
        yield* Fiber.interrupt(fiber);
        assert(Exit.hasInterrupts(yield* Fiber.await(fiber)));
        assert.strictEqual(yield* Ref.get(calls), 1);
      }).pipe(
        Effect.provide(
          observedLoopsTransactionalLayer(base, {}, () =>
            Deferred.succeed(entered, true).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.asVoid,
            ),
          ),
        ),
      );
      assert.strictEqual(yield* Queue.size(fixture.received), 0);
    }),
  );

  it.effect.each([rejected, unknown])(
    "never turns a native observer defect into a settled batch item or erases original evidence %#",
    (failure) =>
      Effect.gen(function* preserveNativeObserverDefect() {
        const fixture = yield* startEmailHttpFixture(loopsReply);
        const defect = new Error("private native observer defect");
        const calls = yield* Ref.make(0);

        const base = suppliedLoopsLayer(loopsLayer(fixture), () =>
          Ref.update(calls, (count) => count + 1).pipe(Effect.andThen(Effect.fail(failure))),
        );

        yield* Effect.gen(function* inspectNativeObserverDefect() {
          const exit = yield* (yield* LoopsTransactionalEmail)
            .sendAll([{ job: loopsJob }, { job: loopsJob }], { concurrency: 1 })
            .pipe(Effect.exit);

          assert(Exit.isFailure(exit));
          assert(Exit.hasDies(exit));
          assert(
            exit.cause.reasons.filter(Cause.isDieReason).some((reason) => reason.defect === defect),
          );

          const retained = exit.cause.reasons
            .filter(Cause.isDieReason)
            .map((reason) => reason.defect)
            .find(Cause.isCause);

          assert(Cause.isCause(retained));
          const original = Cause.findError(retained);
          assert(Result.isSuccess(original));
          assert.strictEqual(original.success, failure);
          assert.strictEqual(yield* Ref.get(calls), 1);
          assert.deepStrictEqual((yield* (yield* EmailNativeObservations).snapshot).observations, [
            failure === rejected
              ? EmailNativeObservationSchema.cases.Rejected.make({
                  operation: "LoopsTransactional",
                })
              : EmailNativeObservationSchema.cases.Unknown.make({
                  operation: "LoopsTransactional",
                }),
          ]);
        }).pipe(
          Effect.provide(observedLoopsTransactionalLayer(base, {}, () => Effect.die(defect))),
        );
      }),
  );

  it.effect(
    "observes completed Loops operations without observing validation or applying defaults twice",
    () =>
      Effect.gen(function* inspectObservedLoopsWire() {
        const fixture = yield* startEmailHttpFixture(loopsReply);
        yield* Effect.gen(function* sendObservedLoops() {
          const loops = yield* LoopsTransactionalEmail;
          const view = yield* EmailNativeObservations;
          const preview = yield* loops.validate(loopsJob, { idempotencyKey: "event" });
          assert.deepStrictEqual(preview.dataVariables, { private: "private data" });
          assert.deepStrictEqual((yield* view.snapshot).observations, []);
          assert.strictEqual(yield* Queue.size(fixture.received), 0);
          assert.strictEqual(loops.idempotency._tag, "KeyForwarding");
          assert.strictEqual(
            (yield* loops.send(loopsJob, { idempotencyKey: "event" }))._tag,
            "Accepted",
          );
          const snapshot = yield* view.snapshot;
          assert.deepStrictEqual(snapshot.observations, [
            EmailNativeObservationSchema.cases.Receipt.make({
              operation: "LoopsTransactional",
              receiptKind: "Accepted",
            }),
          ]);
          assert(
            Object.isFrozen(snapshot) &&
              Object.isFrozen(snapshot.observations) &&
              Object.isFrozen(snapshot.observations[0]),
          );
          assert.notInclude(JSON.stringify(snapshot), "private");
        }).pipe(
          Effect.provide(
            observedLoopsTransactionalLayer(
              defaultedLoopsTransactionalLayer(loopsLayer(fixture), {
                dataVariables: { private: "private data" },
                idempotencyKeyPrefix: "host/",
              }),
            ),
          ),
        );
        assert.strictEqual((yield* Queue.take(fixture.received)).idempotencyKey, "host/event");
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );

  it.effect(
    "observes native Iterable acceptance while excluding unsupported keys and malformed batch items",
    () =>
      Effect.gen(function* inspectObservedIterableWire() {
        const starts = yield* Ref.make(0);
        const fixture = yield* startEmailHttpFixture(iterableReply);
        yield* Effect.gen(function* sendObservedIterable() {
          const iterable = yield* IterableCampaignEmail;
          const view = yield* EmailNativeObservations;
          const preview = yield* iterable.validate(iterableJob);
          assert.deepStrictEqual(preview.dataFields, { private: false });
          assert.strictEqual(yield* Ref.get(starts), 0);
          assert.strictEqual(iterable.idempotency._tag, "None");
          assert.deepStrictEqual((yield* view.snapshot).observations, []);
          const invalid = { ...iterableJob, from: "private@fictional.invalid" };

          const results = yield* iterable.sendAll(
            [
              { job: invalid },
              { job: iterableJob, options: { idempotencyKey: "not-native" } },
              { job: iterableJob },
            ],
            { concurrency: 1 },
          );

          const [malformed, keyed, accepted] = results;
          assert.isDefined(malformed);
          assert.isDefined(keyed);
          assert.isDefined(accepted);
          assert(Result.isFailure(malformed) && malformed.failure instanceof EmailInvalidMessage);
          assert(malformed.failure.issues.every((issue) => issue.path.startsWith("job.")));
          assert(Result.isFailure(keyed) && keyed.failure instanceof EmailRejected);
          assert.strictEqual(keyed.failure.reason, "unsupported-idempotency");
          assert(Result.isSuccess(accepted));
          assert.strictEqual(yield* Ref.get(starts), 1);
          assert.deepStrictEqual((yield* view.snapshot).observations, [
            EmailNativeObservationSchema.cases.Receipt.make({
              operation: "IterableCampaign",
              receiptKind: "Accepted",
            }),
          ]);
        }).pipe(
          Effect.provide(
            observedIterableCampaignLayer(
              defaultedIterableCampaignLayer(iterableLayer(fixture), {
                dataFields: { private: false },
              }),
              {},
              undefined,
              () => Ref.update(starts, (count) => count + 1),
            ),
          ),
        );
        const wire = yield* Queue.take(fixture.received);
        assert.include(wire.body, '"private":false');
        assert.strictEqual(wire.idempotencyKey, "");
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );

  it.effect.each([
    rejected,
    unknown,
    new EmailInvalidMessage({ issues: [] }),
    new EmailInvalidOptions({ issues: [] }),
  ])(
    "returns the original delegated failure and excludes post-preflight local invalidity",
    (failure) =>
      Effect.gen(function* inspectNativeFailureIdentity() {
        const fixture = yield* startEmailHttpFixture(loopsReply);
        const base = suppliedLoopsLayer(loopsLayer(fixture), () => Effect.fail(failure));
        const delivered = yield* Queue.unbounded<typeof EmailNativeObservationSchema.Type>();
        yield* Effect.gen(function* observeNativeFailure() {
          const loops = yield* LoopsTransactionalEmail;
          const view = yield* EmailNativeObservations;
          const result = yield* loops.send(loopsJob).pipe(Effect.result);
          assert(Result.isFailure(result));
          assert.strictEqual(result.failure, failure);
          const snapshot = yield* view.snapshot;

          const expected = new Map([
            [
              "EmailRejected",
              [
                EmailNativeObservationSchema.cases.Rejected.make({
                  operation: "LoopsTransactional",
                }),
              ],
            ],
            [
              "EmailDeliveryUnknown",
              [
                EmailNativeObservationSchema.cases.Unknown.make({
                  operation: "LoopsTransactional",
                }),
              ],
            ],
            ["EmailInvalidMessage", []],
            ["EmailInvalidOptions", []],
          ]);

          assert.deepStrictEqual(snapshot.observations, expected.get(failure._tag));
          assert.strictEqual(yield* Queue.size(delivered), snapshot.observations.length);
          assert.deepStrictEqual(
            yield* Effect.forEach(() => Queue.take(delivered))(snapshot.observations),
            snapshot.observations,
          );
        }).pipe(
          Effect.provide(
            observedLoopsTransactionalLayer(base, {}, (fact) =>
              Queue.offer(delivered, fact).pipe(Effect.asVoid),
            ),
          ),
        );
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );

  it.effect("preserves the exact delegated receipt rather than reconstructing it from a fact", () =>
    Effect.gen(function* inspectNativeReceiptIdentity() {
      const fixture = yield* startEmailHttpFixture(loopsReply);
      const base = suppliedLoopsLayer(loopsLayer(fixture), () => Effect.succeed(receipt));

      const escaped = yield* Effect.gen(function* retainNativeReceiptObservation() {
        const loops = yield* LoopsTransactionalEmail;
        const view = yield* EmailNativeObservations;
        assert.strictEqual(yield* loops.send(loopsJob), receipt);

        return { snapshot: yield* view.snapshot, view };
      }).pipe(Effect.provide(observedLoopsTransactionalLayer(base)));

      assert.deepStrictEqual(yield* escaped.view.snapshot, escaped.snapshot);
      assert.notInclude(JSON.stringify(escaped.snapshot), "private-receipt-id");
    }),
  );

  it.effect.prop(
    "bounds generated completion histories and never resets permanent truncation",
    {
      capacity: Schema.Int.check(Schema.isBetween({ maximum: 5, minimum: 1 })),
      kinds: Schema.Array(Schema.Literals(["Receipt", "Rejected", "Unknown"])).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(16),
      ),
    },
    ({ kinds, capacity }) =>
      Effect.gen(function* inspectGeneratedNativeHistory() {
        const fixture = yield* startEmailHttpFixture(loopsReply);
        const cursor = yield* Ref.make(0);

        const outcomes: Readonly<
          Record<"Receipt" | "Rejected" | "Unknown", Effect.Effect<EmailReceipt, EmailSendError>>
        > = {
          Receipt: Effect.succeed(receipt),
          Rejected: Effect.fail(rejected),
          Unknown: Effect.fail(unknown),
        };

        const base = suppliedLoopsLayer(loopsLayer(fixture), () =>
          Effect.gen(function* nextNativeOutcome() {
            const index = yield* Ref.getAndUpdate(cursor, (current) => current + 1);

            return yield* outcomes[kinds[index] ?? "Receipt"];
          }),
        );

        const options = { capacity };
        yield* Effect.gen(function* collectNativeHistory() {
          const loops = yield* LoopsTransactionalEmail;
          const view = yield* EmailNativeObservations;
          options.capacity = 100;

          for (const kind of kinds) {
            const result = yield* loops.send(loopsJob).pipe(Effect.result);
            assert.strictEqual(Result.isSuccess(result), kind === "Receipt");
          }

          const old = yield* view.snapshot;
          assert.deepStrictEqual(
            old.observations.map((value) => value._tag),
            kinds.slice(-capacity),
          );
          assert.strictEqual(old.truncated, kinds.length > capacity);
          yield* loops.send(loopsJob);
          const next = yield* view.snapshot;
          assert.deepStrictEqual(
            old.observations.map((value) => value._tag),
            kinds.slice(-capacity),
          );
          assert.strictEqual(next.truncated, kinds.length + 1 > capacity);
        }).pipe(Effect.provide(observedLoopsTransactionalLayer(base, options)));
      }),
    { arbitrary: { runs: 12 } },
  );

  it.effect.each([0, 1.5, 10_001, Number.NaN])(
    "refuses capacity %s before native acquisition",
    (capacity) =>
      Effect.gen(function* rejectNativeObservationCapacity() {
        const acquisitions = yield* Ref.make(0);

        const supplied = Layer.effect(
          LoopsTransactionalEmail,
          Ref.update(acquisitions, (value) => value + 1).pipe(
            Effect.andThen(Effect.die("unexpected acquisition")),
          ),
        );

        const error = yield* LoopsTransactionalEmail.pipe(
          Effect.provide(observedLoopsTransactionalLayer(supplied, { capacity })),
          Effect.flip,
        );

        assert(error instanceof EmailConfigurationError);
        assert.strictEqual(yield* Ref.get(acquisitions), 0);
      }),
  );

  it.effect("refuses callback controls before acquiring an Iterable account", () =>
    Effect.gen(function* rejectNativeObservationCallback() {
      const options = { capacity: 1 };
      Reflect.set(options, "privateCallback", "private callback");
      const supplied = Layer.effect(IterableCampaignEmail, Effect.die("unexpected acquisition"));

      const error = yield* IterableCampaignEmail.pipe(
        Effect.provide(observedIterableCampaignLayer(supplied, options)),
        Effect.flip,
      );

      assert(error instanceof EmailConfigurationError);
      assert.notInclude(JSON.stringify(error), "privateCallback");
      assert.notInclude(JSON.stringify(error), "private callback");
    }),
  );

  it.effect("uses completion order rather than start order for concurrent operation facts", () =>
    Effect.gen(function* inspectNativeCompletionOrder() {
      const fixture = yield* startEmailHttpFixture({
        body: "",
        hold: true,
        next: loopsReply,
        status: 200,
      });

      yield* Effect.gen(function* completeNativeOperationsOutOfOrder() {
        const loops = yield* LoopsTransactionalEmail;
        const view = yield* EmailNativeObservations;

        const pending = yield* loops.send(loopsJob).pipe(Effect.result, Effect.forkChild);
        yield* Queue.take(fixture.received);
        const completed = yield* loops.send(loopsJob).pipe(Effect.result, Effect.forkChild);
        yield* Queue.take(fixture.received);
        assert(Result.isSuccess(yield* Fiber.join(completed)));
        assert.deepStrictEqual(
          (yield* view.snapshot).observations.map((value) => value._tag),
          ["Receipt"],
        );
        fixture.server.closeAllConnections();
        assert(Result.isFailure(yield* Fiber.join(pending)));
        assert.deepStrictEqual(
          (yield* view.snapshot).observations.map((value) => value._tag),
          ["Receipt", "Unknown"],
        );
      }).pipe(Effect.provide(observedLoopsTransactionalLayer(loopsLayer(fixture))));
    }),
  );

  it.effect("owns queued native inputs and excludes scheduling that expires before its slot", () =>
    Effect.gen(function* inspectQueuedNativeObservations() {
      const starts = yield* Ref.make(0);
      yield* TestClock.setTime(0);

      const fixture = yield* startEmailHttpFixture({
        body: "",
        hold: true,
        next: iterableReply,
        status: 200,
      });

      const queued = { ...iterableJob, dataFields: { retained: "original" } };
      yield* Effect.gen(function* sendQueuedObservedIterable() {
        const iterable = yield* IterableCampaignEmail;
        const view = yield* EmailNativeObservations;

        const batch = yield* iterable
          .sendAll(
            [
              { job: iterableJob },
              { job: { ...iterableJob, sendAt: "1970-01-01T00:00:01Z" } },
              { job: queued },
            ],
            { concurrency: 1 },
          )
          .pipe(Effect.forkChild);

        yield* Queue.take(fixture.received);
        queued.dataFields.retained = "changed";
        yield* TestClock.adjust(Duration.seconds(2));
        fixture.server.closeAllConnections();
        const [first, expired, last] = yield* Fiber.join(batch);
        assert.isDefined(first);
        assert.isDefined(expired);
        assert.isDefined(last);
        assert(Result.isFailure(first));
        assert(Result.isFailure(expired) && expired.failure instanceof EmailInvalidMessage);
        assert(Result.isSuccess(last));
        assert.include((yield* Queue.take(fixture.received)).body, '"retained":"original"');
        assert.deepStrictEqual(
          (yield* view.snapshot).observations.map((value) => value._tag),
          ["Unknown", "Receipt"],
        );
        assert.strictEqual(yield* Ref.get(starts), 3);
      }).pipe(
        Effect.provide(
          observedIterableCampaignLayer(iterableLayer(fixture), {}, undefined, () =>
            Ref.update(starts, (count) => count + 1),
          ),
        ),
      );
    }),
  );

  it.effect(
    "does not observe interruption or run queued operations after native cancellation",
    () =>
      Effect.gen(function* interruptNativeObservationBatch() {
        const fixture = yield* startEmailHttpFixture({ body: "", hold: true, status: 200 });
        yield* Effect.gen(function* cancelObservedNative() {
          const loops = yield* LoopsTransactionalEmail;
          const view = yield* EmailNativeObservations;

          const batch = yield* loops
            .sendAll([{ job: loopsJob }, { job: loopsJob }], { concurrency: 1 })
            .pipe(Effect.forkChild);

          yield* Queue.take(fixture.received);
          yield* Fiber.interrupt(batch);
          assert(Exit.hasInterrupts(yield* Fiber.await(batch)));
          assert.strictEqual(yield* Queue.take(fixture.closed), true);
          assert.strictEqual(yield* Queue.size(fixture.received), 0);
          assert.deepStrictEqual((yield* view.snapshot).observations, []);
        }).pipe(Effect.provide(observedLoopsTransactionalLayer(loopsLayer(fixture))));
      }),
  );

  it.effect("records a modeled deadline once without granting uncertain keyed replay", () =>
    Effect.gen(function* inspectObservedNativeDeadline() {
      const fixture = yield* startEmailHttpFixture({ body: "", hold: true, status: 200 });
      yield* Effect.gen(function* expireObservedNativeOperation() {
        const loops = yield* LoopsTransactionalEmail;
        const view = yield* EmailNativeObservations;

        const pending = yield* loops
          .send(loopsJob, {
            idempotencyKey: "private-event",
            policy: { ...policy, deadline: Duration.seconds(1) },
          })
          .pipe(Effect.result, Effect.forkChild);

        yield* Queue.take(fixture.received);
        yield* TestClock.adjust(Duration.seconds(1));
        const result = yield* Fiber.join(pending);
        assert(Result.isFailure(result) && result.failure instanceof EmailDeliveryUnknown);
        assert.strictEqual(result.failure.reason, "timeout");
        assert.strictEqual(yield* Queue.take(fixture.closed), true);
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
        assert.deepStrictEqual((yield* view.snapshot).observations, [
          EmailNativeObservationSchema.cases.Unknown.make({ operation: "LoopsTransactional" }),
        ]);
      }).pipe(Effect.provide(observedLoopsTransactionalLayer(loopsLayer(fixture))));
    }),
  );

  it.effect("does not erase earlier uncertainty when a later explicit operation conflicts", () =>
    Effect.gen(function* preserveNativeUncertaintyFacts() {
      const fixture = yield* startEmailHttpFixture({
        body: "{}",
        next: {
          body: '{"success":false,"message":"Idempotency key already used with a different request body."}',
          status: 409,
        },
        status: 503,
      });

      yield* Effect.gen(function* observeDistinctNativeOperations() {
        const loops = yield* LoopsTransactionalEmail;
        const view = yield* EmailNativeObservations;

        const first = yield* loops
          .send(loopsJob, { idempotencyKey: "private-event" })
          .pipe(Effect.result);

        assert(Result.isFailure(first) && first.failure instanceof EmailDeliveryUnknown);

        const later = yield* loops
          .send(loopsJob, { idempotencyKey: "private-event" })
          .pipe(Effect.result);

        assert(Result.isFailure(later) && later.failure instanceof EmailRejected);
        assert.strictEqual(later.failure.reason, "idempotency-conflict");
        assert.deepStrictEqual(
          (yield* view.snapshot).observations.map((value) => value._tag),
          ["Unknown", "Rejected"],
        );
      }).pipe(Effect.provide(observedLoopsTransactionalLayer(loopsLayer(fixture))));
      assert.strictEqual(yield* Queue.size(fixture.received), 2);
    }),
  );

  it.effect(
    "keeps independently acquired native views separate while escaped snapshots remain readable",
    () =>
      Effect.gen(function* isolateNativeObservationViews() {
        const fixture = yield* startEmailHttpFixture(loopsReply);
        const observed = observedLoopsTransactionalLayer(loopsLayer(fixture));

        const first = yield* Effect.gen(function* acquireFirstNativeView() {
          const loops = yield* LoopsTransactionalEmail;
          const view = yield* EmailNativeObservations;
          yield* loops.send(loopsJob);

          return view;
        }).pipe(Effect.provide(observed));

        yield* Effect.gen(function* acquireSecondNativeView() {
          const loops = yield* LoopsTransactionalEmail;
          const view = yield* EmailNativeObservations;
          assert.deepStrictEqual((yield* view.snapshot).observations, []);
          yield* loops.send(loopsJob);
          assert.strictEqual((yield* view.snapshot).observations.length, 1);
          assert.strictEqual((yield* first.snapshot).observations.length, 1);
        }).pipe(Effect.provide(observed));
      }),
  );

  it.effect(
    "preserves defects and resource release without retaining private causes in facts or spans",
    () =>
      Effect.gen(function* preserveNativeObservationDefects() {
        const fixture = yield* startEmailHttpFixture(loopsReply);
        const released = yield* Deferred.make<boolean>();
        const trace = yield* startEmailTraceFixture();

        const lifecycle = Layer.effectDiscard(
          Effect.acquireRelease(Effect.void, () => Deferred.succeed(released, true)),
        );

        const base = suppliedLoopsLayer(loopsLayer(fixture), () =>
          Effect.die("private original defect"),
        ).pipe(Layer.provide(lifecycle));

        const escaped = yield* Effect.gen(function* inspectDefectiveNativeOperation() {
          const loops = yield* LoopsTransactionalEmail;
          const view = yield* EmailNativeObservations;
          const exit = yield* loops.send(loopsJob).pipe(Effect.exit);
          assert(Exit.hasDies(exit));
          assert.include(JSON.stringify(exit), "private original defect");
          assert.deepStrictEqual((yield* view.snapshot).observations, []);

          return view;
        }).pipe(
          Effect.provide(observedLoopsTransactionalLayer(base)),
          Effect.withTracer(trace.tracer),
        );

        assert.strictEqual(yield* Deferred.await(released), true);
        assert.deepStrictEqual((yield* escaped.snapshot).observations, []);
        const diagnostics = yield* trace.diagnostics;
        assert.include(diagnostics, "ObservedLoopsTransactionalEmail.send");
        assert.notInclude(diagnostics, "private original defect");
        assert.notInclude(diagnostics, loopsJob.email);
        assert.notInclude(diagnostics, loopsJob.transactionalId);
      }),
  );
});
