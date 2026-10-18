import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Layer, Queue, Redacted, Result, Schema } from "effect";
import { emailFixtureClientLayer, startEmailHttpFixture } from "../test/email-http-fixture.js";
import { startEmailTraceFixture } from "../test/email-tracing-fixture.js";
import {
  Email,
  EmailConfigurationError,
  EmailDeliveryUnknown,
  EmailReceiptSchema,
  EmailRejected,
  EmailRouter,
  EmailSender,
  EmailSenderIdempotencySchema,
  emailLayer,
  emailRouterLayer,
  observedEmailRouterLayer,
} from "./index.js";
import type { EmailReceipt, EmailSubmissionError } from "./index.js";
import {
  EmailObservationAggregate,
  EmailObservationAggregateError,
  EmailObservationAggregateSnapshotSchema,
  EmailObservationAggregateSourceSchema,
  EmailSubmissionObservations,
  EmailSubmissionObservationSchema,
  EmailSubmissionObservationSnapshotSchema,
  aggregatedEmailObservationsLayer,
  observedEmailSenderLayer,
} from "./email-submission-observations.js";
import {
  EmailNativeObservationSchema,
  observedLoopsTransactionalLayer,
  observedIterableCampaignLayer,
} from "./email-native-observations.js";
import { IterableCampaignEmail, iterableCampaignLayer } from "./iterable-campaign-email.js";
import { LoopsTransactionalEmail, loopsTransactionalLayer } from "./loops-transactional-email.js";
import {
  failingSenderLayer,
  recordingEmailCapabilities,
  recordingSenderLayer,
} from "./email-testing.js";

const message = {
  body: { text: "private-fact-aggregate-body" },
  from: "sender@example.test",
  subject: "private-fact-aggregate-subject",
  to: "recipient@example.test",
};

const recordingAccount = (capacity = 2) =>
  emailLayer().pipe(
    Layer.provideMerge(observedEmailSenderLayer(Layer.fresh(recordingSenderLayer), { capacity })),
  );

const emptySnapshot = () =>
  EmailSubmissionObservationSnapshotSchema.make({ observations: [], truncated: false });

const emptyView = () => EmailSubmissionObservations.of({ snapshot: Effect.sync(emptySnapshot) });

describe("explicit minimal observation aggregation", () => {
  it.effect("shares routed observation stores and releases their account lifetime", () =>
    Effect.gen(function* assembleObservedRoutes() {
      const released = yield* Queue.unbounded<boolean>();
      const lifetime = Layer.effectDiscard(Effect.addFinalizer(() => Queue.offer(released, true)));

      const accounts = observedEmailRouterLayer(
        [
          { layer: recordingAccount().pipe(Layer.provide(lifetime)), name: "primary" },
          { layer: recordingAccount(), name: "backup" },
        ],
        { primary: "primary" },
      );

      yield* Effect.gen(function* submitToOwnedObservationStores() {
        yield* (yield* Email).send(message);
        const backup = yield* (yield* EmailRouter).select({ primary: "backup" });
        yield* backup.send(message);
        yield* backup.send(message);
        const snapshot = yield* (yield* EmailObservationAggregate).snapshot;
        const [first, second] = snapshot.sources;
        assert.isDefined(second);
        assert.strictEqual(first.name, "primary");
        assert.strictEqual(second.name, "backup");
        assert.strictEqual(first.snapshot.observations.length, 1);
        assert.strictEqual(second.snapshot.observations.length, 2);
        assert.strictEqual(snapshot.retainedObservations, 3);
        assert.strictEqual(yield* Queue.size(released), 0);
      }).pipe(Effect.provide(accounts));
      assert.strictEqual(yield* Queue.take(released), true);
      assert.strictEqual(yield* Queue.size(released), 0);
    }),
  );

  it.effect.each(["Plan", "Extra"] as const)(
    "rejects invalid assembled %s before acquiring observation stores",
    (mode) =>
      Effect.gen(function* validateObservedRouteAssembly() {
        const account = recordingAccount().pipe(
          Layer.provide(Layer.effectDiscard(Effect.die("unexpected account acquisition"))),
        );

        const binding = { layer: account, name: "account" };

        if (mode === "Extra") {
          Reflect.set(binding, "private-field", "private-value");
        }

        const error = yield* EmailObservationAggregate.pipe(
          Effect.provide(
            observedEmailRouterLayer([binding], {
              primary: mode === "Plan" ? "missing" : "account",
            }),
          ),
          Effect.flip,
        );

        assert(error instanceof EmailConfigurationError);
        assert.notInclude(JSON.stringify(error), "private");
      }),
  );

  it.effect.each(["Rejected", "Unknown"] as const)(
    "reads the actual named route views without widening %s fallback",
    (mode) =>
      Effect.gen(function* aggregateRoutedFacts() {
        const outcomes = {
          Rejected: new EmailRejected({ provider: "fixture", reason: "authentication" }),
          Unknown: new EmailDeliveryUnknown({ provider: "fixture", reason: "transport" }),
        };

        const primary = emailLayer().pipe(
          Layer.provideMerge(observedEmailSenderLayer(failingSenderLayer(outcomes[mode]))),
        );

        const backup = recordingAccount();

        const router = emailRouterLayer(
          [
            { layer: primary, name: "primary" },
            { layer: backup, name: "backup" },
          ],
          { fallbacks: ["backup"], primary: "primary" },
        );

        const aggregate = aggregatedEmailObservationsLayer([
          { kind: "Submission", layer: primary, name: "primary" },
          { kind: "Submission", layer: backup, name: "backup" },
        ]);

        yield* Effect.gen(function* sendThenReadActualFactStores() {
          const result = yield* (yield* Email).send(message).pipe(Effect.result);
          assert.strictEqual(Result.isSuccess(result), mode === "Rejected");
          const snapshot = yield* (yield* EmailObservationAggregate).snapshot;
          const [first, second] = snapshot.sources;
          assert.isDefined(second);
          assert(EmailObservationAggregateSourceSchema.guards.SenderInvocation(first));
          assert.strictEqual(first.snapshot.observations[0]?._tag, mode);
          assert.strictEqual(second.snapshot.observations.length, mode === "Rejected" ? 1 : 0);
          assert.strictEqual(snapshot.retainedObservations, mode === "Rejected" ? 2 : 1);
          assert.deepStrictEqual(
            snapshot.sources.map((source) => source.name),
            ["primary", "backup"],
          );
        }).pipe(Effect.provide(Layer.mergeAll(router, aggregate)));
      }),
  );

  it.effect(
    "keeps sender-invocation and real native-operation facts discriminated, encodable and payload-free",
    () =>
      Effect.gen(function* aggregateDistinctFactUnits() {
        const fixture = yield* startEmailHttpFixture({ body: '{"success":true}', status: 200 });
        const common = recordingAccount();

        const native = observedLoopsTransactionalLayer(
          loopsTransactionalLayer({
            apiKey: Redacted.make("private-fictional-key"),
            attachments: "Disabled",
            templateAuthority: "ProviderManaged",
          }).pipe(Layer.provide(emailFixtureClientLayer(fixture.url, "https://app.loops.so"))),
        );

        const campaignFixture = yield* startEmailHttpFixture({
          body: '{"code":"Success","msg":"private-native-response"}',
          status: 200,
        });

        const campaign = observedIterableCampaignLayer(
          iterableCampaignLayer({
            apiKey: Redacted.make("private-fictional-key"),
            campaignAuthority: "AuthorizeProviderManagedCampaign",
            contactWrites: "AuthorizeProfileCreation",
            dataRetention: "AuthorizePersistedSendData",
            projectIdentity: "EmailBased",
            region: "US",
            tracking: "AuthorizeCampaignTracking",
          }).pipe(
            Layer.provide(emailFixtureClientLayer(campaignFixture.url, "https://api.iterable.com")),
          ),
        );

        const aggregate = aggregatedEmailObservationsLayer([
          { kind: "Submission", layer: common, name: "common" },
          { kind: "Native", layer: native, name: "native" },
          { kind: "Native", layer: campaign, name: "campaign" },
        ]);

        yield* Effect.gen(function* submitMixedFactOperations() {
          yield* (yield* Email).send(message, {
            executionMetadata: { tenant: "private-context-value" },
            idempotencyKey: "private-context-key",
          });
          yield* (yield* LoopsTransactionalEmail).send({
            dataVariables: { value: "private-native-value" },
            email: message.to,
            transactionalId: "private-template",
          });
          yield* (yield* IterableCampaignEmail).send({
            campaignId: 123,
            dataFields: { value: "private-campaign-value" },
            recipientEmail: message.to,
          });
          const snapshot = yield* (yield* EmailObservationAggregate).snapshot;
          const [sender, operation, campaignSource] = snapshot.sources;
          assert.isDefined(operation);
          assert(EmailObservationAggregateSourceSchema.guards.SenderInvocation(sender));
          assert(EmailObservationAggregateSourceSchema.guards.NativeOperation(operation));
          const [fact] = operation.snapshot.observations;
          assert.isDefined(fact);
          assert.strictEqual(fact.operation, "LoopsTransactional");
          assert.isDefined(campaignSource);
          assert(EmailObservationAggregateSourceSchema.guards.NativeOperation(campaignSource));
          const [campaignFact] = campaignSource.snapshot.observations;
          assert.isDefined(campaignFact);
          assert.strictEqual(campaignFact.operation, "IterableCampaign");
          assert.strictEqual(snapshot.retainedObservations, 3);

          const encoded = yield* Schema.encodeEffect(
            Schema.toCodecJson(EmailObservationAggregateSnapshotSchema),
          )(snapshot);

          const decoded = yield* Schema.decodeEffect(
            Schema.toCodecJson(EmailObservationAggregateSnapshotSchema),
          )(encoded);

          assert.strictEqual(decoded.retainedObservations, 3);

          for (const value of [
            message.body.text,
            message.to,
            "private-context-key",
            "private-context-value",
            "private-template",
            "private-native-value",
            "private-campaign-value",
            "private-native-response",
            "private-fictional-key",
          ]) {
            assert.notInclude(JSON.stringify(encoded), value);
          }
        }).pipe(Effect.provide(Layer.mergeAll(common, native, campaign, aggregate)));
        assert.strictEqual(yield* Queue.size(fixture.received), 1);
        assert.strictEqual(yield* Queue.size(campaignFixture.received), 1);
      }).pipe(Effect.scoped),
  );

  it.effect.prop(
    "retains each source's own outcome suffix and gap rather than a global send history",
    {
      first: Schema.Array(Schema.Literals(["Recorded", "Rejected", "Unknown"])).check(
        Schema.isMaxLength(6),
      ),
      second: Schema.Array(Schema.Literals(["Recorded", "Rejected", "Unknown"])).check(
        Schema.isMaxLength(6),
      ),
    },
    ({ first, second }) =>
      Effect.gen(function* preserveGeneratedFactRetention() {
        const planned = yield* Queue.unbounded<Result.Result<EmailReceipt, EmailSubmissionError>>();

        const outcomes = {
          Recorded: Result.succeed(EmailReceiptSchema.cases.Recorded.make({ sequence: 1 })),
          Rejected: Result.fail(
            new EmailRejected({ provider: "fixture", reason: "authentication" }),
          ),
          Unknown: Result.fail(
            new EmailDeliveryUnknown({ provider: "fixture", reason: "transport" }),
          ),
        };

        yield* Queue.offerAll(
          planned,
          [...first, ...second].map((mode) => outcomes[mode]),
        );

        const sender = Layer.succeed(
          EmailSender,
          EmailSender.of({
            capabilities: recordingEmailCapabilities,
            idempotency: EmailSenderIdempotencySchema.cases.None.make({}),
            provider: "fixture",
            submit: () => Queue.take(planned).pipe(Effect.flatMap(Effect.fromResult)),
            validate: () => Effect.void,
          }),
        );

        const account = (capacity: number) =>
          emailLayer().pipe(Layer.provideMerge(observedEmailSenderLayer(sender, { capacity })));

        const a = account(2);
        const b = account(3);

        const aggregate = aggregatedEmailObservationsLayer([
          { kind: "Submission", layer: a, name: "first" },
          { kind: "Submission", layer: b, name: "second" },
        ]);

        const router = emailRouterLayer(
          [
            { layer: a, name: "first" },
            { layer: b, name: "second" },
          ],
          { primary: "first" },
        );

        yield* Effect.gen(function* executeGeneratedOutcomes() {
          const routes = yield* EmailRouter;
          const firstRoute = yield* routes.select({ primary: "first" });
          const secondRoute = yield* routes.select({ primary: "second" });
          yield* Effect.forEach(first, () => firstRoute.send(message).pipe(Effect.result), {
            concurrency: 1,
          });
          yield* Effect.forEach(second, () => secondRoute.send(message).pipe(Effect.result), {
            concurrency: 1,
          });
          const snapshot = yield* (yield* EmailObservationAggregate).snapshot;

          const category = {
            Recorded: "Receipt",
            Rejected: "Rejected",
            Unknown: "Unknown",
          } as const;

          assert.deepStrictEqual(
            snapshot.sources[0].snapshot.observations.map((fact) => fact._tag),
            first.slice(-2).map((mode) => category[mode]),
          );
          assert.deepStrictEqual(
            snapshot.sources[1]?.snapshot.observations.map((fact) => fact._tag),
            second.slice(-3).map((mode) => category[mode]),
          );
          assert.strictEqual(snapshot.truncated, first.length > 2 || second.length > 3);
          assert.strictEqual(
            snapshot.retainedObservations,
            Math.min(first.length, 2) + Math.min(second.length, 3),
          );
        }).pipe(Effect.provide(Layer.mergeAll(router, aggregate)));
      }),
  );

  it.effect("reports mixed-time samples honestly under concurrent source completion", () =>
    Effect.gen(function* observeNonAtomicFactSamples() {
      const entered = yield* Deferred.make<boolean>();
      const release = yield* Deferred.make<boolean>();
      const first = recordingAccount();
      const base = observedEmailSenderLayer(Layer.fresh(recordingSenderLayer));

      const delayed = Layer.effect(
        EmailSubmissionObservations,
        Effect.gen(function* delaySecondFactSample() {
          const view = yield* EmailSubmissionObservations;

          return EmailSubmissionObservations.of({
            snapshot: Deferred.succeed(entered, true).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(view.snapshot),
            ),
          });
        }),
      ).pipe(Layer.provideMerge(base));

      const second = emailLayer().pipe(Layer.provideMerge(delayed));

      const aggregate = aggregatedEmailObservationsLayer([
        { kind: "Submission", layer: first, name: "first" },
        { kind: "Submission", layer: second, name: "second" },
      ]);

      const router = emailRouterLayer(
        [
          { layer: first, name: "first" },
          { layer: second, name: "second" },
        ],
        { primary: "first" },
      );

      yield* Effect.gen(function* interleaveMinimalFactQuery() {
        const routes = yield* EmailRouter;
        const a = yield* routes.select({ primary: "first" });
        const b = yield* routes.select({ primary: "second" });
        const view = yield* EmailObservationAggregate;
        const fiber = yield* view.snapshot.pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        yield* a.send(message);
        yield* b.send(message);
        yield* Deferred.succeed(release, true);
        const mixed = yield* Fiber.join(fiber);
        assert.strictEqual(mixed.sources[0].snapshot.observations.length, 0);
        assert.strictEqual(mixed.sources[1]?.snapshot.observations.length, 1);
        assert.strictEqual(mixed.retainedObservations, 1);
        assert.strictEqual((yield* view.snapshot).retainedObservations, 2);
      }).pipe(Effect.provide(Layer.mergeAll(router, aggregate)));
    }).pipe(Effect.scoped),
  );

  it.effect("owns every binding's metadata and Layer before waiting for acquisition", () =>
    Effect.gen(function* ownPendingFactBindings() {
      const entered = yield* Deferred.make<boolean>();
      const release = yield* Deferred.make<boolean>();

      const first = Layer.effect(
        EmailSubmissionObservations,
        Deferred.succeed(entered, true).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.map(emptyView),
        ),
      );

      const second = {
        kind: "Submission",
        layer: Layer.sync(EmailSubmissionObservations, emptyView),
        name: "original",
      } as const;

      const aggregate = aggregatedEmailObservationsLayer([
        { kind: "Submission", layer: first, name: "first" },
        second,
      ]);

      const fiber = yield* EmailObservationAggregate.pipe(
        Effect.flatMap((view) => view.snapshot),
        Effect.provide(aggregate),
        Effect.forkScoped,
      );

      yield* Deferred.await(entered);
      Reflect.set(second, "name", "changed");
      Reflect.set(
        second,
        "layer",
        Layer.effect(EmailSubmissionObservations, Effect.die("private-unexpected-acquisition")),
      );
      Reflect.set(second, "kind", "Native");
      yield* Deferred.succeed(release, true);
      const snapshot = yield* Fiber.join(fiber);
      assert.strictEqual(snapshot.sources[1]?.name, "original");
      assert.strictEqual(snapshot.sources[1]?.unit, "SenderInvocation");
    }).pipe(Effect.scoped),
  );

  it.effect.each(["Name", "Duplicate", "Extra", "Bound"] as const)(
    "refuses %s metadata before acquiring sources and hides private input",
    (mode) =>
      Effect.gen(function* refuseInvalidFactRegistrations() {
        const source = Layer.effect(
          EmailSubmissionObservations,
          Effect.die("private-unexpected-acquisition"),
        );

        const first = { kind: "Submission", layer: source, name: "first" } as const;
        const second = { kind: "Submission", layer: source, name: "second" } as const;

        const corrupt = {
          Bound: () => true,
          Duplicate: () => Reflect.set(second, "name", "first"),
          Extra: () => Reflect.set(second, "private-key", "private-value"),
          Name: () => Reflect.set(second, "name", "private invalid name"),
        };

        corrupt[mode]();

        const rest =
          mode === "Bound"
            ? Array.from({ length: 15 }, (_, index) => ({ ...second, name: `source_${index}` }))
            : [];

        const error = yield* EmailObservationAggregate.pipe(
          Effect.provide(aggregatedEmailObservationsLayer([first, second, ...rest])),
          Effect.flip,
        );

        assert(error instanceof EmailConfigurationError);
        assert.notInclude(JSON.stringify(error), "private");
      }),
  );

  it.effect("rejects aliases of one view and releases acquired resources", () =>
    Effect.gen(function* releaseAliasedFactView() {
      const released = yield* Deferred.make<boolean>();

      const source = Layer.effect(
        EmailSubmissionObservations,
        Effect.acquireRelease(Effect.sync(emptyView), () => Deferred.succeed(released, true)),
      );

      const error = yield* EmailObservationAggregate.pipe(
        Effect.provide(
          aggregatedEmailObservationsLayer([
            { kind: "Submission", layer: source, name: "first" },
            { kind: "Submission", layer: source, name: "alias" },
          ]),
        ),
        Effect.flip,
      );

      assert(error instanceof EmailConfigurationError);
      assert.strictEqual(yield* Deferred.await(released), true);
    }),
  );

  it.effect.each(["Extra", "Unit", "Truncation"] as const)(
    "returns a fixed safe error for %s source facts",
    (mode) =>
      Effect.gen(function* refuseMalformedFactData() {
        const trace = yield* startEmailTraceFixture();
        const snapshot = emptySnapshot();

        const corrupt = {
          Extra: () => Reflect.set(snapshot, "private-source-data", "private-extra-value"),
          Truncation: () => Reflect.set(snapshot, "truncated", "private-wrong-value"),
          Unit: () =>
            Reflect.set(snapshot, "observations", [
              EmailNativeObservationSchema.cases.Receipt.make({
                operation: "LoopsTransactional",
                receiptKind: "Accepted",
              }),
            ]),
        };

        corrupt[mode]();

        const source = Layer.succeed(
          EmailSubmissionObservations,
          EmailSubmissionObservations.of({ snapshot: Effect.succeed(snapshot) }),
        );

        const error = yield* EmailObservationAggregate.pipe(
          Effect.flatMap((view) => view.snapshot),
          Effect.provide(
            aggregatedEmailObservationsLayer([
              { kind: "Submission", layer: source, name: "source" },
            ]),
          ),
          Effect.withTracer(trace.tracer),
          Effect.flip,
        );

        assert(error instanceof EmailObservationAggregateError);
        assert.strictEqual(error.reason, "invalid-source");
        assert.notInclude(JSON.stringify(error), "private");
        assert.notInclude(yield* trace.diagnostics, "private");
      }),
  );

  it.effect("detaches and freezes samples while later queries reflect actual source changes", () =>
    Effect.gen(function* ownMinimalFactSamples() {
      const snapshot = EmailSubmissionObservationSnapshotSchema.make({
        observations: [
          EmailSubmissionObservationSchema.cases.Receipt.make({
            provider: "configured",
            receiptKind: "Recorded",
          }),
        ],
        truncated: false,
      });

      const source = Layer.succeed(
        EmailSubmissionObservations,
        EmailSubmissionObservations.of({ snapshot: Effect.succeed(snapshot) }),
      );

      yield* Effect.gen(function* queryThenMutateFactData() {
        const view = yield* EmailObservationAggregate;
        const first = yield* view.snapshot;
        assert(EmailObservationAggregateSourceSchema.guards.SenderInvocation(first.sources[0]));
        const [fact] = first.sources[0].snapshot.observations;
        const [originalFact] = snapshot.observations;
        assert.isDefined(fact);
        assert.isDefined(originalFact);
        Reflect.set(originalFact, "provider", "changed");
        assert.strictEqual(fact.provider, "configured");
        assert.strictEqual(Reflect.set(fact, "provider", "tampered"), false);
        const current = yield* view.snapshot;
        assert(EmailObservationAggregateSourceSchema.guards.SenderInvocation(current.sources[0]));
        assert.strictEqual(current.sources[0].snapshot.observations[0]?.provider, "changed");
        assert(Object.isFrozen(first.sources));
        assert(Object.isFrozen(first.sources[0].snapshot.observations));
      }).pipe(
        Effect.provide(
          aggregatedEmailObservationsLayer([{ kind: "Submission", layer: source, name: "source" }]),
        ),
      );
    }),
  );

  it.effect.each(["Defect", "Interruption"] as const)(
    "propagates query %s without returning a partial aggregate or recording private span data",
    (mode) =>
      Effect.gen(function* preserveFactReadCause() {
        const trace = yield* startEmailTraceFixture();
        const entered = yield* Deferred.make<boolean>();
        const first = Layer.sync(EmailSubmissionObservations, emptyView);
        const outcomes = { Defect: Effect.die("private-read-defect"), Interruption: Effect.never };

        const second = Layer.succeed(
          EmailSubmissionObservations,
          EmailSubmissionObservations.of({
            snapshot: Deferred.succeed(entered, true).pipe(Effect.andThen(outcomes[mode])),
          }),
        );

        const aggregate = aggregatedEmailObservationsLayer([
          { kind: "Submission", layer: first, name: "first" },
          { kind: "Submission", layer: second, name: "second" },
        ]);

        const fiber = yield* EmailObservationAggregate.pipe(
          Effect.flatMap((view) => view.snapshot),
          Effect.provide(aggregate),
          Effect.withTracer(trace.tracer),
          Effect.forkScoped,
        );

        yield* Deferred.await(entered);

        if (mode === "Interruption") {
          yield* Fiber.interrupt(fiber);
        }

        const exit = yield* Fiber.await(fiber);
        assert.strictEqual(Exit.hasDies(exit), mode === "Defect");
        assert.strictEqual(Exit.hasInterrupts(exit), mode === "Interruption");
        const diagnostics = yield* trace.diagnostics;
        assert.include(diagnostics, "EmailObservationAggregate.snapshot");
        assert.notInclude(diagnostics, "private-read-defect");
      }).pipe(Effect.scoped),
  );
});
