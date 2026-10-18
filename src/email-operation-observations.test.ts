import { assert, describe, it } from "@effect/vitest";
import {
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Queue,
  Redacted,
  Result,
  Schema,
} from "effect";
import { TestClock } from "effect/testing";
import { emailFixtureClientLayer, startEmailHttpFixture } from "../test/email-http-fixture.js";
import { startEmailTraceFixture } from "../test/email-tracing-fixture.js";
import {
  Email,
  EmailDeliveryUnknown,
  EmailInvalidMessage,
  EmailOperationOutcomeSchema,
  EmailReceiptSchema,
  EmailRejected,
  EmailSender,
  EmailSenderIdempotencySchema,
  emailLayer,
  emailRouterLayer,
  observedEmailOperationLayer,
} from "./index.js";
import type {
  EmailOperationEvent,
  EmailOperationObserver,
  EmailReceipt,
  EmailSubmissionError,
} from "./index.js";
import { EmailAgent, EmailAgentApproval, emailAgentLayer } from "./email-agent.js";
import { defaultedEmailLayer } from "./email-defaults.js";
import { transformedEmailLayer } from "./email-transformation.js";
import {
  RecordedEmails,
  recordingEmailLayer,
  recordingSenderLayer,
  recordingEmailCapabilities,
} from "./recording-email-sender.js";
import { resendEmailLayer } from "./resend-email-sender.js";
import { sendgridEmailLayer } from "./sendgrid-email-sender.js";

const message = {
  body: { text: "private-operation-body" },
  from: "sender@example.test",
  subject: "private-operation-subject",
  to: "recipient@example.test",
};

const policy = {
  deadline: Duration.seconds(10),
  initialDelay: Duration.millis(100),
  maxAttempts: 2,
};

const fixtureEmail = (submit: () => Effect.Effect<EmailReceipt, EmailSubmissionError>) =>
  emailLayer(policy).pipe(
    Layer.provide(
      Layer.succeed(
        EmailSender,
        EmailSender.of({
          capabilities: recordingEmailCapabilities,
          idempotency: EmailSenderIdempotencySchema.cases.None.make({}),
          provider: "fixture",
          submit,
          validate: () => Effect.void,
        }),
      ),
    ),
  );

const decodeReceipt = Schema.decodeEffect(Schema.fromJsonString(EmailReceiptSchema));

describe("prepared operation lifecycle observers", () => {
  it.effect(
    "does not observe validation/preparation and preserves keyed result identity on each execution",
    () =>
      Effect.gen(function* observeOnlyExecution() {
        const events = yield* Queue.unbounded<EmailOperationEvent>();

        const layer = observedEmailOperationLayer(
          defaultedEmailLayer(recordingEmailLayer, { idempotencyKeyPrefix: "host/" }),
          (event) => Queue.offer(events, event).pipe(Effect.asVoid),
        );

        yield* Effect.gen(function* executePreparedObservedOperation() {
          const email = yield* Email;
          yield* email.validate(message);

          const operation = yield* email.prepare(message, {
            executionMetadata: { tenant: "private-tenant" },
            idempotencyKey: "event",
          });

          yield* operation.validate;
          assert.strictEqual(yield* Queue.size(events), 0);
          const first = yield* operation.send;
          assert.strictEqual(yield* operation.send, first);
          const event = yield* Queue.take(events);
          assert.strictEqual(event.previews[0].options.idempotencyKey, "host/event");
          assert.strictEqual(event.previews[0].options.executionMetadata?.tenant, "private-tenant");
          assert(EmailOperationOutcomeSchema.guards.Receipt(event.outcome));
          assert.deepStrictEqual(event.outcome.receipt, first);
          assert.notStrictEqual(event.outcome.receipt, first);
          assert(Object.isFrozen(event));
          assert(Object.isFrozen(event.outcome.receipt));
          assert.strictEqual(yield* Queue.size(events), 1);
        }).pipe(Effect.provide(layer));
      }),
  );

  it.effect(
    "runs only after approval and submits the same transformed content without rerendering",
    () =>
      Effect.gen(function* bindApprovalToObservedExecution() {
        const events = yield* Queue.unbounded<EmailOperationEvent>();
        const decisions = yield* Queue.unbounded<"Approved" | "Declined">();
        const reviewed = yield* Queue.unbounded<string>();
        const revisions = yield* Queue.unbounded<string>();
        yield* Queue.offerAll(revisions, [
          "declined",
          "reviewed",
          "unreviewed",
          "another-unreviewed",
        ]);

        const layer = observedEmailOperationLayer(
          transformedEmailLayer(recordingEmailLayer, ({ message: input }) =>
            Queue.take(revisions).pipe(
              Effect.map((revision) => ({ ...input, subject: `${input.subject}/${revision}` })),
            ),
          ),
          (event) => Queue.offer(events, event).pipe(Effect.asVoid),
        ).pipe(Layer.provideMerge(recordingSenderLayer));

        const agentLayer = emailAgentLayer({ from: message.from }).pipe(
          Layer.provide(
            Layer.succeed(
              EmailAgentApproval,
              EmailAgentApproval.of({
                review: (proposal) =>
                  Queue.offer(reviewed, proposal.previews[0].message.subject).pipe(
                    Effect.andThen(Queue.take(decisions)),
                  ),
              }),
            ),
          ),
          Layer.provideMerge(layer),
        );

        yield* Effect.gen(function* approveThenObserve() {
          const agent = yield* EmailAgent;
          yield* Queue.offer(decisions, "Declined");

          const declined = yield* agent
            .submit({ body: message.body, subject: message.subject, to: message.to })
            .pipe(Effect.result);

          assert(Result.isFailure(declined));
          assert.strictEqual(yield* Queue.take(reviewed), `${message.subject}/declined`);
          assert.strictEqual(yield* Queue.size(events), 0);
          yield* Queue.offer(decisions, "Approved");

          const receipt = yield* agent.submit({
            body: message.body,
            subject: message.subject,
            to: message.to,
          });

          const event = yield* Queue.take(events);
          assert(EmailOperationOutcomeSchema.guards.Receipt(event.outcome));
          assert.deepStrictEqual(event.outcome.receipt, receipt);
          const [recorded] = yield* (yield* RecordedEmails).messages;
          assert.isDefined(recorded);
          assert.strictEqual(recorded.subject, yield* Queue.take(reviewed));
          assert.strictEqual(recorded.subject, `${message.subject}/reviewed`);
          assert.deepStrictEqual(recorded, event.previews[0].message);
        }).pipe(Effect.provide(agentLayer));
      }),
  );

  it.effect(
    "preserves accepting-route correlation and isolates nested receipt data from callback mutation",
    () =>
      Effect.gen(function* ownObservedRecipientOutcome() {
        const events = yield* Queue.unbounded<EmailOperationEvent>();

        const receipt = yield* decodeReceipt(
          '{"_tag":"RecipientOutcomes","outcomes":[{"_tag":"Accepted","messageId":"fictional-id","recipient":"recipient@example.test"}],"provider":"fixture"}',
        );

        const account = fixtureEmail(() => Effect.succeed(receipt));

        const routed = emailRouterLayer([{ layer: account, name: "account" }], {
          primary: "account",
        });

        const result = yield* Email.pipe(
          Effect.flatMap((email) => email.send(message)),
          Effect.provide(
            observedEmailOperationLayer(routed, (event) =>
              Queue.offer(events, event).pipe(Effect.asVoid),
            ),
          ),
        );

        const event = yield* Queue.take(events);
        assert(EmailOperationOutcomeSchema.guards.Receipt(event.outcome));
        assert.strictEqual(event.outcome.route, "account");
        assert(EmailReceiptSchema.guards.RecipientOutcomes(event.outcome.receipt));
        assert(EmailReceiptSchema.guards.RecipientOutcomes(result));
        Reflect.set(event.outcome.receipt.outcomes[0], "messageId", "changed-id");
        assert.strictEqual(result.outcomes[0].messageId, "fictional-id");
        assert(Object.isFrozen(event.outcome.receipt.outcomes));
        assert(Object.isFrozen(event.outcome.receipt.outcomes[0]));
        assert.deepStrictEqual(event.previews[0].routes.map(String), ["account"]);
      }),
  );

  it.effect.each(["Rejected", "Unknown"] as const)(
    "observes final %s without replacing the original failure",
    (mode) =>
      Effect.gen(function* preserveObservedFailureIdentity() {
        const failures = {
          Rejected: new EmailRejected({
            provider: "fixture",
            reason: "authentication",
            status: 401,
          }),
          Unknown: new EmailDeliveryUnknown({ provider: "fixture", reason: "transport" }),
        };

        const original = failures[mode];
        const events = yield* Queue.unbounded<EmailOperationEvent>();

        const result = yield* Email.pipe(
          Effect.flatMap((email) => email.send(message)),
          Effect.provide(
            observedEmailOperationLayer(
              fixtureEmail(() => Effect.fail(original)),
              (event) => Queue.offer(events, event).pipe(Effect.asVoid),
            ),
          ),
          Effect.result,
        );

        assert(Result.isFailure(result));
        assert.strictEqual(result.failure, original);
        const event = yield* Queue.take(events);
        assert(EmailOperationOutcomeSchema.guards.Failure(event.outcome));
        assert.notStrictEqual(event.outcome.failure, original);
        assert.strictEqual(event.outcome.failure._tag, original._tag);
        assert(Object.isFrozen(event.outcome.failure));
        assert.strictEqual(yield* Queue.size(events), 0);
      }),
  );

  it.effect(
    "settles batch and personalized callbacks per executed item, with owned shared context",
    () =>
      Effect.gen(function* observeSettledItems() {
        const events = yield* Queue.unbounded<EmailOperationEvent>();

        const layer = observedEmailOperationLayer(recordingEmailLayer, (event) =>
          Queue.offer(events, event).pipe(Effect.asVoid),
        );

        yield* Effect.gen(function* executeBatchAndAudience() {
          const email = yield* Email;

          const batch = yield* email.sendAll([
            { message },
            { message: { ...message, subject: "" } },
          ]);

          assert(batch[0] !== undefined && Result.isSuccess(batch[0]));
          assert(batch[1] !== undefined && Result.isFailure(batch[1]));

          const personalized = yield* email.sendPersonalized(
            {
              message: {
                body: { text: "%recipient.name%" },
                from: message.from,
                subject: "%recipient.name%",
              },
              recipients: [
                { to: "first@example.test", variables: { name: "First" } },
                { to: "second@example.test", variables: { name: "Second" } },
              ],
            },
            { concurrency: 1, executionMetadata: { tenant: "private-shared-context" } },
          );

          assert(personalized.every(Result.isSuccess));
          const all = yield* Queue.takeAll(events);
          assert.deepStrictEqual(
            all.map((event) => event.previews[0].message.subject),
            [message.subject, "First", "Second"],
          );
          assert.strictEqual(
            all[1]?.previews[0].options.executionMetadata?.tenant,
            "private-shared-context",
          );
        }).pipe(Effect.provide(layer));
      }),
  );

  it.effect.each(["Receipt", "Rejected", "Unknown"] as const)(
    "a callback defect after %s never retries or reaches fallback",
    (mode) =>
      Effect.gen(function* stopAfterObserverDefect() {
        const calls = yield* Queue.unbounded<string>();

        const outcomes = {
          Receipt: Effect.succeed(EmailReceiptSchema.cases.Recorded.make({ sequence: 1 })),
          Rejected: Effect.fail(
            new EmailRejected({ provider: "fixture", reason: "authentication" }),
          ),
          Unknown: Effect.fail(
            new EmailDeliveryUnknown({ provider: "fixture", reason: "transport" }),
          ),
        };

        const primary = observedEmailOperationLayer(
          fixtureEmail(
            Effect.fnUntraced(function* submitPrimaryOutcome() {
              yield* Queue.offer(calls, "primary");

              return yield* outcomes[mode];
            }),
          ),
          () =>
            Effect.die(
              new EmailRejected({ provider: "callback", reason: "temporarily-unavailable" }),
            ),
        );

        const backup = fixtureEmail(() =>
          Queue.offer(calls, "backup").pipe(
            Effect.as(EmailReceiptSchema.cases.Recorded.make({ sequence: 2 })),
          ),
        );

        const exit = yield* Email.pipe(
          Effect.flatMap((email) => email.send(message)),
          Effect.provide(
            emailRouterLayer(
              [
                { layer: primary, name: "primary" },
                { layer: backup, name: "backup" },
              ],
              { fallbacks: ["backup"], primary: "primary" },
            ),
          ),
          Effect.exit,
        );

        assert(Exit.hasDies(exit));
        assert.deepStrictEqual(yield* Queue.takeAll(calls), ["primary"]);
      }),
  );

  it.effect(
    "defensively treats an untyped callback's modeled failure as a defect rather than replay authority",
    () =>
      Effect.gen(function* containUntypedCallbackFailure() {
        const calls = yield* Queue.unbounded<string>();

        const callbacks = { observe: () => Effect.void } satisfies Record<
          "observe",
          EmailOperationObserver
        >;

        Reflect.set(callbacks, "observe", () =>
          Effect.fail(new EmailRejected({ provider: "callback", reason: "rate-limited" })),
        );

        const primary = observedEmailOperationLayer(
          fixtureEmail(() =>
            Queue.offer(calls, "primary").pipe(
              Effect.as(EmailReceiptSchema.cases.Recorded.make({ sequence: 1 })),
            ),
          ),
          callbacks.observe,
        );

        const backup = fixtureEmail(() =>
          Queue.offer(calls, "backup").pipe(
            Effect.as(EmailReceiptSchema.cases.Recorded.make({ sequence: 2 })),
          ),
        );

        const exit = yield* Email.pipe(
          Effect.flatMap((email) => email.send(message)),
          Effect.provide(
            emailRouterLayer(
              [
                { layer: primary, name: "primary" },
                { layer: backup, name: "backup" },
              ],
              { fallbacks: ["backup"], primary: "primary" },
            ),
          ),
          Effect.exit,
        );

        assert(Exit.hasDies(exit));
        assert.deepStrictEqual(yield* Queue.takeAll(calls), ["primary"]);
      }),
  );

  it.effect(
    "keeps callback waiting outside the underlying provider deadline and preserves cancellation after acceptance",
    () =>
      Effect.gen(function* interruptPostAcceptanceCallback() {
        const entered = yield* Deferred.make<boolean>();
        const released = yield* Deferred.make<boolean>();

        const layer = observedEmailOperationLayer(recordingEmailLayer, () =>
          Effect.acquireRelease(Deferred.succeed(entered, true), () =>
            Deferred.succeed(released, true),
          ).pipe(Effect.andThen(Effect.never), Effect.scoped),
        ).pipe(Layer.provideMerge(recordingSenderLayer));

        yield* Effect.gen(function* cancelPendingCompletionObserver() {
          const fiber = yield* (yield* Email)
            .send(message, { policy: { ...policy, deadline: Duration.seconds(1) } })
            .pipe(Effect.forkScoped);

          yield* Deferred.await(entered);
          yield* TestClock.adjust("2 seconds");
          assert.strictEqual((yield* (yield* RecordedEmails).messages).length, 1);
          yield* Fiber.interrupt(fiber);
          assert(Exit.hasInterrupts(yield* Fiber.await(fiber)));
          assert.strictEqual(yield* Deferred.await(released), true);
          assert.strictEqual((yield* (yield* RecordedEmails).messages).length, 1);
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped),
  );

  it.effect.each(["Defect", "Interrupt", "Compound"] as const)(
    "does not turn a source %s into a modeled completion event",
    (mode) =>
      Effect.gen(function* skipUnsettledSourceCauses() {
        const events = yield* Queue.unbounded<EmailOperationEvent>();
        const entered = yield* Deferred.make<boolean>();
        const failure = new EmailRejected({ provider: "fixture", reason: "authentication" });

        const outcomes = {
          Compound: Effect.fail(failure).pipe(
            Effect.ensuring(Effect.die("private-finalizer-defect")),
          ),
          Defect: Effect.die("private-source-defect"),
          Interrupt: Effect.never,
        };

        const layer = observedEmailOperationLayer(
          fixtureEmail(() => Deferred.succeed(entered, true).pipe(Effect.andThen(outcomes[mode]))),
          (event) => Queue.offer(events, event).pipe(Effect.asVoid),
        );

        const fiber = yield* Email.pipe(
          Effect.flatMap((email) => email.send(message)),
          Effect.provide(layer),
          Effect.forkScoped,
        );

        yield* Deferred.await(entered);

        if (mode === "Interrupt") {
          yield* Fiber.interrupt(fiber);
        }

        const exit = yield* Fiber.await(fiber);
        assert(Exit.isFailure(exit));
        assert.strictEqual(Exit.hasInterrupts(exit), mode === "Interrupt");
        assert.strictEqual(Exit.hasDies(exit), mode !== "Interrupt");
        assert.strictEqual(yield* Queue.size(events), 0);
      }).pipe(Effect.scoped),
  );

  it.effect("observes one final repaired receipt rather than each eligible HTTP attempt", () =>
    Effect.gen(function* observeRepairedLogicalOperation() {
      const fixture = yield* startEmailHttpFixture({
        body: '{"name":"internal_server_error","message":"private-provider-text"}',
        next: { body: '{"id":"fictional-repaired-id"}', status: 200 },
        status: 503,
      });

      const events = yield* Queue.unbounded<EmailOperationEvent>();
      const waiting = yield* Deferred.make<boolean>();
      const release = yield* Deferred.make<boolean>();

      const provider = resendEmailLayer(
        { apiKey: Redacted.make("fictional-unused-key") },
        policy,
        () =>
          Deferred.succeed(waiting, true).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.asVoid,
          ),
      ).pipe(Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.resend.com")));

      const layer = observedEmailOperationLayer(provider, (event) =>
        Queue.offer(events, event).pipe(Effect.asVoid),
      );

      yield* Effect.gen(function* awaitRepairBeforeNotification() {
        const fiber = yield* (yield* Email)
          .send(message, { idempotencyKey: "private-repair-key" })
          .pipe(Effect.forkScoped);

        yield* Deferred.await(waiting);
        assert.strictEqual(yield* Queue.size(events), 0);
        yield* TestClock.adjust("1 second");
        yield* Deferred.succeed(release, true);
        yield* TestClock.adjust("1 second");
        const receipt = yield* Fiber.join(fiber);
        const first = yield* Queue.take(fixture.received);
        const second = yield* Queue.take(fixture.received);
        assert.strictEqual(first.body, second.body);
        assert.strictEqual(first.idempotencyKey, second.idempotencyKey);
        const event = yield* Queue.take(events);
        assert(EmailOperationOutcomeSchema.guards.Receipt(event.outcome));
        assert.deepStrictEqual(event.outcome.receipt, receipt);
        assert.strictEqual(event.previews[0].options.idempotencyKey, "private-repair-key");
        assert.strictEqual(yield* Queue.size(events), 0);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
  );

  it.effect(
    "owns modeled local issues after queued routed intent expires, without another HTTP request",
    () =>
      Effect.gen(function* observeQueuedLocalFailure() {
        const fixture = yield* startEmailHttpFixture({ body: "", status: 202 });
        const entered = yield* Deferred.make<boolean>();
        const release = yield* Deferred.make<boolean>();
        const events = yield* Queue.unbounded<EmailOperationEvent>();

        const provider = sendgridEmailLayer({ apiKey: Redacted.make("fictional-unused-key") }).pipe(
          Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.sendgrid.com")),
        );

        const routed = emailRouterLayer([{ layer: provider, name: "account" }], {
          primary: "account",
        });

        const layer = observedEmailOperationLayer(routed, (event) =>
          Queue.offer(events, event).pipe(
            Effect.andThen(
              EmailOperationOutcomeSchema.guards.Receipt(event.outcome)
                ? Deferred.succeed(entered, true).pipe(Effect.andThen(Deferred.await(release)))
                : Effect.void,
            ),
            Effect.asVoid,
          ),
        );

        yield* Effect.gen(function* expireNextQueuedItem() {
          const fiber = yield* (yield* Email)
            .sendAll([{ message }, { message: { ...message, sendAt: "1970-01-01T00:00:01Z" } }], {
              concurrency: 1,
            })
            .pipe(Effect.forkScoped);

          yield* Deferred.await(entered);
          yield* TestClock.adjust("2 seconds");
          yield* Deferred.succeed(release, true);
          const results = yield* Fiber.join(fiber);
          assert(results[0] !== undefined && Result.isSuccess(results[0]));
          assert(results[1] !== undefined && Result.isFailure(results[1]));
          const first = yield* Queue.take(events);
          const second = yield* Queue.take(events);
          assert(EmailOperationOutcomeSchema.guards.Receipt(first.outcome));
          assert(EmailOperationOutcomeSchema.guards.Failure(second.outcome));
          assert(second.outcome.failure instanceof EmailInvalidMessage);
          assert(Object.isFrozen(second.outcome.failure.issues));
          assert(Object.isFrozen(second.outcome.failure.issues[0]));
          assert.strictEqual(yield* Queue.size(fixture.received), 1);
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped),
  );

  it.effect(
    "preserves eligible rejection-only fallback while an outer observer receives all candidate previews",
    () =>
      Effect.gen(function* observeAtDistinctRoutingBoundaries() {
        const events = yield* Queue.unbounded<EmailOperationEvent>();

        const observe: EmailOperationObserver = (event) =>
          Queue.offer(events, event).pipe(Effect.asVoid);

        const primary = observedEmailOperationLayer(
          fixtureEmail(() =>
            Effect.fail(new EmailRejected({ provider: "fixture", reason: "authentication" })),
          ),
          observe,
        );

        const backup = transformedEmailLayer(recordingEmailLayer, ({ message: input }) =>
          Effect.succeed({ ...input, subject: `${input.subject}/Backup` }),
        );

        const router = emailRouterLayer(
          [
            { layer: primary, name: "primary" },
            { layer: backup, name: "backup" },
          ],
          { fallbacks: ["backup"], primary: "primary" },
        );

        const receipt = yield* Email.pipe(
          Effect.flatMap((email) => email.send(message)),
          Effect.provide(observedEmailOperationLayer(router, observe)),
        );

        const rejected = yield* Queue.take(events);
        const accepted = yield* Queue.take(events);
        assert(EmailOperationOutcomeSchema.guards.Failure(rejected.outcome));
        assert(rejected.outcome.failure instanceof EmailRejected);
        assert(EmailOperationOutcomeSchema.guards.Receipt(accepted.outcome));
        assert.strictEqual(accepted.outcome.route, "backup");
        assert(EmailReceiptSchema.guards.Recorded(receipt));
        assert.deepStrictEqual(
          accepted.previews.map((preview) => [preview.message.subject, ...preview.routes]),
          [
            [message.subject, "primary"],
            [`${message.subject}/Backup`, "backup"],
          ],
        );
        assert.strictEqual(yield* Queue.size(events), 0);
      }),
  );

  it.effect(
    "a malformed host-service acknowledgement yields a fixed private-safe defect, not a callback or replay",
    () =>
      Effect.gen(function* refuseMalformedHostOutcome() {
        const trace = yield* startEmailTraceFixture();
        const events = yield* Queue.unbounded<EmailOperationEvent>();
        const calls = yield* Queue.unbounded<boolean>();
        const receipt = EmailReceiptSchema.cases.Recorded.make({ sequence: 1 });
        Reflect.set(receipt, "rawProviderPayload", "private-unmodeled-provider-output");

        const layer = observedEmailOperationLayer(
          fixtureEmail(() => Queue.offer(calls, true).pipe(Effect.as(receipt))),
          (event) => Queue.offer(events, event).pipe(Effect.asVoid),
        );

        const exit = yield* Email.pipe(
          Effect.flatMap((email) => email.send(message)),
          Effect.provide(layer),
          Effect.withTracer(trace.tracer),
          Effect.exit,
        );

        assert(Exit.hasDies(exit));
        assert.include(JSON.stringify(exit), "EmailOperationObservationError");
        assert.notInclude(JSON.stringify(exit), "private-unmodeled-provider-output");
        assert.notInclude(yield* trace.diagnostics, "private-unmodeled-provider-output");
        assert.strictEqual(yield* Queue.size(events), 0);
        assert.strictEqual(yield* Queue.size(calls), 1);
      }),
  );

  it.effect(
    "keeps callback inputs, outcomes, private context and original defects out of SDK spans",
    () =>
      Effect.gen(function* minimizeLifecycleSpanData() {
        const trace = yield* startEmailTraceFixture();

        const result = yield* Email.pipe(
          Effect.flatMap((email) =>
            email.send(message, {
              executionMetadata: { tenant: "private-tenant" },
              idempotencyKey: "private-operation-key",
            }),
          ),
          Effect.provide(
            observedEmailOperationLayer(recordingEmailLayer, () =>
              Effect.die("private-callback-defect"),
            ),
          ),
          Effect.withTracer(trace.tracer),
          Effect.exit,
        );

        assert(Exit.hasDies(result));
        const diagnostics = yield* trace.diagnostics;
        assert.include(diagnostics, "EmailOperation.observe");

        for (const value of [
          message.body.text,
          message.subject,
          message.to,
          "private-tenant",
          "private-operation-key",
          "private-callback-defect",
        ]) {
          assert.notInclude(diagnostics, value);
        }
      }),
  );
});
