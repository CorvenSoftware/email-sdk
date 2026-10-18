import { assert, describe, it } from "@effect/vitest";
import {
  Context,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Predicate,
  Queue,
  Redacted,
  Ref,
  Result,
  Schema,
} from "effect";
import { TestClock } from "effect/testing";
import { emailFixtureClientLayer, startEmailHttpFixture } from "../test/email-http-fixture.js";
import { startEmailTraceFixture } from "../test/email-tracing-fixture.js";
import {
  Email,
  EmailInvalidMessage,
  EmailInvalidOptions,
  EmailReceiptSchema,
  EmailSendOptionsSchema,
  transformedEmailLayer,
} from "./index.js";
import type {
  EmailExecutionMetadataInputValue,
  EmailMessageInput,
  EmailMessageTransform,
  EmailOperationObserver,
} from "./index.js";
import { defaultedEmailLayer } from "./email-defaults.js";
import { postmarkEmailLayer } from "./postmark-email-sender.js";
import { sendgridPersonalizedEmailLayer } from "./sendgrid-email-sender.js";
import { mailgunPersonalizedEmailLayer } from "./mailgun-email-sender.js";
import { EmailConfigurationError } from "./email-configuration-error.js";
import { EmailRouter, emailRouterLayer } from "./email-routing.js";
import { observedEmailOperationLayer } from "./email-operation-observations.js";
import { resendEmailLayer } from "./resend-email-sender.js";
import {
  RecordedEmails,
  recordingEmailLayer,
  recordingSenderLayer,
} from "./recording-email-sender.js";

class EmailExtensionHost extends Context.Service<
  EmailExtensionHost,
  { readonly suffix: string; readonly observe: (subject: string) => Effect.Effect<void> }
>()("test/EmailExtensionHost") {}

const message: EmailMessageInput = {
  body: { html: "<p>Original</p>", text: "Original" },
  from: "sender@example.test",
  subject: "Original",
  to: "recipient@example.test",
};

const policy = {
  deadline: Duration.seconds(10),
  initialDelay: Duration.millis(100),
  maxAttempts: 2,
};

describe("prepared email transformations", () => {
  it.effect.each(["SendGrid", "Mailgun"] as const)(
    "refuses unsupported %s native audience composition before transport",
    (provider) =>
      Effect.gen(function* refuseNativeAudienceDowngrade() {
        const fixture = yield* startEmailHttpFixture({ body: "", status: 202 });

        const native =
          provider === "SendGrid"
            ? sendgridPersonalizedEmailLayer({ apiKey: Redacted.make("fictional-key") })
            : mailgunPersonalizedEmailLayer({
                apiKey: Redacted.make("fictional-key"),
                domain: "fictional.invalid",
              });

        const account = native.pipe(
          Layer.provide(
            emailFixtureClientLayer(
              fixture.url,
              provider === "SendGrid" ? "https://api.sendgrid.com" : "https://api.mailgun.net",
            ),
          ),
        );

        const compositions = [
          defaultedEmailLayer(account, {}),
          transformedEmailLayer(account, ({ message: input }) => Effect.succeed(input)),
          observedEmailOperationLayer(account, () => Effect.void),
          emailRouterLayer([{ layer: account, name: "native" }], { primary: "native" }),
        ];

        for (const composition of compositions) {
          const acquired = yield* Email.pipe(Effect.provide(composition), Effect.result);
          assert(Result.isFailure(acquired));
          assert(acquired.failure instanceof EmailConfigurationError);
          assert(acquired.failure.issues.some((issue) => issue.path === "personalization"));
        }

        yield* Effect.gen(function* selectMixedPersonalizationRoutes() {
          const router = yield* EmailRouter;

          for (const plan of [
            { primary: "native" },
            { fallbacks: ["native"], primary: "individual" },
          ] as const) {
            const selected = yield* router.select(plan).pipe(Effect.result);
            assert(Result.isFailure(selected));
            assert(selected.failure instanceof EmailInvalidOptions);
            assert(selected.failure.issues.some((issue) => issue.path === "personalization"));
          }

          const receipt = yield* (yield* Email).send(message);
          assert.strictEqual(receipt._tag, "Recorded");
        }).pipe(
          Effect.provide(
            emailRouterLayer(
              [
                { layer: recordingEmailLayer, name: "individual" },
                { layer: account, name: "native" },
              ],
              { primary: "individual" },
            ),
          ),
        );
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }).pipe(Effect.scoped),
  );

  it.effect("keeps acquired extensions usable until their shared host scope closes", () =>
    Effect.gen(function* acquireEmailExtensionsOnce() {
      const events = yield* Queue.unbounded<string>();

      const host = Layer.effect(
        EmailExtensionHost,
        Effect.acquireRelease(
          Effect.sync(() =>
            EmailExtensionHost.of({
              observe: (subject) => Queue.offer(events, subject).pipe(Effect.asVoid),
              suffix: "/Host",
            }),
          ),
          () => Queue.offer(events, "released"),
        ),
      );

      const transform = Effect.gen(function* acquireHostTransformation() {
        const dependency = yield* EmailExtensionHost;

        const callback: EmailMessageTransform = ({ message: input }) =>
          Effect.succeed({ ...input, subject: `${input.subject}${dependency.suffix}` });

        return callback;
      });

      const observer = Effect.gen(function* acquireHostObserver() {
        const dependency = yield* EmailExtensionHost;

        const callback: EmailOperationObserver = (event) =>
          dependency.observe(event.previews[0].message.subject);

        return callback;
      });

      const account = observedEmailOperationLayer(
        transformedEmailLayer(recordingEmailLayer, transform),
        observer,
      ).pipe(Layer.provide(host));

      yield* Effect.gen(function* useAcquiredExtensions() {
        const email = yield* Email;
        yield* email.send(message);
        yield* email.send({ ...message, subject: "Second" });
        assert.strictEqual(yield* Queue.take(events), "Original/Host");
        assert.strictEqual(yield* Queue.take(events), "Second/Host");
        assert.strictEqual(yield* Queue.size(events), 0);
      }).pipe(Effect.provide(account));
      assert.strictEqual(yield* Queue.take(events), "released");
      assert.strictEqual(yield* Queue.size(events), 0);
    }),
  );

  it.effect("propagates extension acquisition failures before any submission", () =>
    Effect.gen(function* refuseFailedExtensionAcquisition() {
      const failure = new EmailInvalidOptions({
        issues: [{ path: "host", problem: "Host extension acquisition refused" }],
      });

      const layer = transformedEmailLayer(recordingEmailLayer, Effect.fail(failure));
      const result = yield* Email.pipe(Effect.provide(layer), Effect.result);
      assert(Result.isFailure(result));
      assert.strictEqual(result.failure, failure);
    }),
  );

  it.effect.prop(
    "preserves generated literal content and per-operation context through preview and submission",
    { suffix: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9&<>]{1,16}$/u)) },
    ({ suffix }) =>
      Effect.gen(function* preserveGeneratedPreparedIntent() {
        const layer = transformedEmailLayer(recordingEmailLayer, ({ message: input, options }) => {
          const contextSuffix = options.executionMetadata?.suffix;
          assert(Predicate.isString(contextSuffix) || contextSuffix === undefined);

          return Effect.succeed({
            ...input,
            body: { text: `${input.body.text}/${contextSuffix}` },
          });
        }).pipe(Layer.provideMerge(recordingSenderLayer));

        yield* Effect.gen(function* submitGeneratedPreview() {
          const operation = yield* (yield* Email).prepare(message, {
            executionMetadata: { suffix },
          });

          yield* operation.validate;
          yield* operation.send;
          const [recorded] = yield* (yield* RecordedEmails).messages;
          assert.isDefined(recorded);
          assert.deepStrictEqual(recorded, operation.previews[0].message);
          assert.strictEqual(recorded.body.text, `Original/${suffix}`);
        }).pipe(Effect.provide(layer));
      }),
  );

  it.effect(
    "finishes every item's transformation before any batch transport and owns earlier outputs while waiting",
    () =>
      Effect.gen(function* prepareWholeTransformedBatch() {
        const waiting = yield* Deferred.make<boolean>();
        const release = yield* Deferred.make<boolean>();
        const output = { text: "Owned first rendering" };

        const layer = transformedEmailLayer(recordingEmailLayer, ({ message: input }) =>
          input.subject === "Second"
            ? Deferred.succeed(waiting, true).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as(input),
              )
            : Effect.succeed({ ...input, body: output }),
        ).pipe(Layer.provideMerge(recordingSenderLayer));

        yield* Effect.gen(function* queueCompletePreparation() {
          const fiber = yield* (yield* Email)
            .sendAll([{ message }, { message: { ...message, subject: "Second" } }])
            .pipe(Effect.forkScoped);

          yield* Deferred.await(waiting);
          assert.deepStrictEqual(yield* (yield* RecordedEmails).messages, []);
          output.text = "Changed while second item waited";
          yield* Deferred.succeed(release, true);
          assert((yield* Fiber.join(fiber)).every(Result.isSuccess));
          const [first] = yield* (yield* RecordedEmails).messages;
          assert.isDefined(first);
          assert.strictEqual(first.body.text, "Owned first rendering");
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped),
  );

  it.effect("keeps local transformation waiting outside the provider submission deadline", () =>
    Effect.gen(function* separatePreparationAndSubmissionLifetimes() {
      const entered = yield* Deferred.make<boolean>();
      const release = yield* Deferred.make<boolean>();

      const layer = transformedEmailLayer(recordingEmailLayer, ({ message: input }) =>
        Deferred.succeed(entered, true).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(input),
        ),
      ).pipe(Layer.provideMerge(recordingSenderLayer));

      yield* Effect.gen(function* waitBeforeSubmissionPolicy() {
        const fiber = yield* (yield* Email)
          .send(message, { policy: { ...policy, deadline: Duration.seconds(1) } })
          .pipe(Effect.forkScoped);

        yield* Deferred.await(entered);
        yield* TestClock.adjust("2 seconds");
        assert.deepStrictEqual(yield* (yield* RecordedEmails).messages, []);
        yield* Deferred.succeed(release, true);
        assert.strictEqual((yield* Fiber.join(fiber))._tag, "Recorded");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
  );

  it.effect(
    "owns one transformed operation through nested defaults, explicit revalidation and keyed execution",
    () =>
      Effect.gen(function* preservePreparedTransformation() {
        const ordinal = yield* Ref.make(0);
        const source = { ...message, body: { text: "Original source" } };
        const metadata = { tenant: "private-tenant" };
        const renderedBody = { text: "Owned rendered content" };

        const layer = defaultedEmailLayer(
          transformedEmailLayer(
            defaultedEmailLayer(recordingEmailLayer, {
              headers: [{ name: "X-Inner", value: "inner" }],
              idempotencyKeyPrefix: "inner/",
            }),
            ({ message: input, options }) =>
              Ref.getAndUpdate(ordinal, (value) => value + 1).pipe(
                Effect.map((value) => {
                  assert.strictEqual(options.executionMetadata?.tenant, "private-tenant");
                  assert.strictEqual(options.idempotencyKey, "outer/event");
                  assert(Object.isFrozen(input.body));
                  assert(Object.isFrozen(options.executionMetadata));

                  return { ...input, body: renderedBody, subject: `${input.subject}/${value}` };
                }),
              ),
          ),
          { headers: [{ name: "X-Outer", value: "outer" }], idempotencyKeyPrefix: "outer/" },
        ).pipe(Layer.provideMerge(recordingSenderLayer));

        yield* Effect.gen(function* executeOwnedPreparedOperation() {
          const email = yield* Email;

          const operation = yield* email.prepare(source, {
            executionMetadata: metadata,
            idempotencyKey: "event",
          });

          const [preview] = operation.previews;
          source.body.text = "Changed source";
          renderedBody.text = "Changed rendering";
          metadata.tenant = "Changed metadata";
          assert.strictEqual(preview.options.idempotencyKey, "inner/outer/event");
          assert.deepStrictEqual(preview.routes, []);
          yield* operation.validate;
          const first = yield* operation.send;
          assert.strictEqual(yield* operation.send, first);
          const [recorded] = yield* (yield* RecordedEmails).messages;
          assert.isDefined(recorded);
          assert.deepStrictEqual(recorded, preview.message);
          assert.strictEqual(recorded.subject, "Original/0");
          assert.strictEqual(recorded.body.text, "Owned rendered content");
          assert.deepStrictEqual(
            recorded.headers?.map((header) => header.name),
            ["X-Inner", "X-Outer"],
          );
          assert.strictEqual(preview.options.executionMetadata?.tenant, "private-tenant");
          assert(Object.isFrozen(operation));
          assert(Object.isFrozen(operation.previews));
          assert(Object.isFrozen(preview.routes));
        }).pipe(Effect.provide(layer));
      }),
  );

  it.effect(
    "settles transformed batch failures in input order and keeps per-item execution metadata isolated",
    () =>
      Effect.gen(function* settleTransformedBatch() {
        const email = yield* Email;

        const result = yield* email.sendAll([
          { message, options: { executionMetadata: { suffix: "first" } } },
          { message, options: { executionMetadata: { invalid: true } } },
          { message, options: { executionMetadata: { suffix: "third" } } },
        ]);

        const [first, invalid, third] = result;
        assert(first !== undefined && Result.isSuccess(first));
        assert(invalid !== undefined && Result.isFailure(invalid));
        assert(third !== undefined && Result.isSuccess(third));
        assert(invalid.failure instanceof EmailInvalidMessage);
        assert.strictEqual(invalid.failure.issues[0]?.path, "message.subject");
        const records = yield* (yield* RecordedEmails).messages;
        assert.deepStrictEqual(
          records.map((record) => record.subject),
          ["Original/first", "Original/third"],
        );
      }).pipe(
        Effect.provide(
          transformedEmailLayer(recordingEmailLayer, ({ message: input, options }) => {
            const suffix = options.executionMetadata?.suffix;
            assert(Predicate.isString(suffix) || suffix === undefined);

            return Effect.succeed({
              ...input,
              subject:
                options.executionMetadata?.invalid === true ? "" : `${input.subject}/${suffix}`,
            });
          }).pipe(Layer.provideMerge(recordingSenderLayer)),
        ),
      ),
  );

  it.effect("owns shared audience context before any recipient transformation can wait", () =>
    Effect.gen(function* ownPersonalizedExecutionContext() {
      const entered = yield* Deferred.make<boolean>();
      const release = yield* Deferred.make<boolean>();
      const date = DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-02T03:04:05.123Z"));

      const metadata = {
        count: 0,
        details: { at: date, revision: "original" },
        empty: null,
        enabled: false,
        tenant: "original-shared-context",
      };

      const layer = transformedEmailLayer(recordingEmailLayer, ({ message: input, options }) =>
        Effect.gen(function* renderContextualRecipient() {
          if (input.subject === "First") {
            yield* Deferred.succeed(entered, true);
            yield* Deferred.await(release);
          }

          const context = options.executionMetadata;
          assert.isDefined(context);
          const { tenant, count, enabled, empty } = context;
          assert(Predicate.isString(tenant));
          assert(Predicate.isNumber(count));
          assert(Predicate.isBoolean(enabled));
          assert(empty === null);

          const { details } = context;
          assert(
            Schema.is(Schema.Struct({ at: Schema.DateTimeUtc, revision: Schema.String }))(details),
          );

          return {
            ...input,
            subject: `${input.subject}/${tenant}/${count}/${enabled}/${empty}/${details.revision}/${DateTime.formatIso(details.at)}`,
          };
        }),
      ).pipe(Layer.provideMerge(recordingSenderLayer));

      yield* Effect.gen(function* submitOwnedContextualAudience() {
        const fiber = yield* (yield* Email)
          .sendPersonalized(
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
            { executionMetadata: metadata },
          )
          .pipe(Effect.forkScoped);

        yield* Deferred.await(entered);
        metadata.tenant = "changed-while-preparing";
        metadata.details.revision = "changed";
        date.setUTCFullYear(2030);
        assert.deepStrictEqual(yield* (yield* RecordedEmails).messages, []);
        yield* Deferred.succeed(release, true);
        assert((yield* Fiber.join(fiber)).every(Result.isSuccess));
        const records = yield* (yield* RecordedEmails).messages;
        assert.deepStrictEqual(records.map((record) => record.subject).toSorted(), [
          "First/original-shared-context/0/false/null/original/2026-01-02T03:04:05.123Z",
          "Second/original-shared-context/0/false/null/original/2026-01-02T03:04:05.123Z",
        ]);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
  );

  it.effect("runs after escaped personalization and does not reapply appended content", () =>
    Effect.gen(function* transformExpandedPersonalization() {
      const results = yield* (yield* Email).sendPersonalized(
        {
          message: {
            body: { html: "<p>%recipient.name%</p>", text: "%recipient.name%" },
            from: message.from,
            subject: "%recipient.name%",
          },
          recipients: [
            { to: "first@example.test", variables: { name: "<First>" } },
            { to: "second@example.test", variables: { name: "Second" } },
          ],
        },
        { executionMetadata: { suffix: "Host" } },
      );

      assert(results.every(Result.isSuccess));
      const [first, second] = yield* (yield* RecordedEmails).messages;
      assert.isDefined(first);
      assert.isDefined(second);
      assert.strictEqual(first.body.html, "<p>&lt;First&gt;</p><footer>Host</footer>");
      assert.strictEqual(first.body.text, "<First>|Host");
      assert.strictEqual(second.body.text, "Second|Host");
    }).pipe(
      Effect.provide(
        transformedEmailLayer(recordingEmailLayer, ({ message: input, options }) => {
          const suffix = options.executionMetadata?.suffix;
          assert(Predicate.isString(suffix));

          return Effect.succeed({
            ...input,
            body: {
              html: `${input.body.html}<footer>${suffix}</footer>`,
              text: `${input.body.text}|${suffix}`,
            },
          });
        }).pipe(Layer.provideMerge(recordingSenderLayer)),
      ),
    ),
  );

  it.effect("validates transformed content against the actual provider before HTTP", () =>
    Effect.gen(function* rejectUnsupportedTransformation() {
      const fixture = yield* startEmailHttpFixture({ body: "{}", status: 200 });

      const provider = postmarkEmailLayer({
        serverToken: Redacted.make("fictional-unused-key"),
      }).pipe(Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.postmarkapp.com")));

      const result = yield* Email.pipe(
        Effect.flatMap((email) => email.send(message)),
        Effect.provide(
          transformedEmailLayer(provider, ({ message: input }) =>
            Effect.succeed({ ...input, sendAt: "2099-01-01T00:00:00Z" }),
          ),
        ),
        Effect.result,
      );

      assert(Result.isFailure(result));
      assert(result.failure instanceof EmailInvalidMessage);
      assert.strictEqual(yield* Queue.size(fixture.received), 0);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "sends the effective content on the real wire without implicitly forwarding private execution metadata",
    () =>
      Effect.gen(function* submitTransformedWireIntent() {
        const fixture = yield* startEmailHttpFixture({
          body: '{"ErrorCode":0,"MessageID":"fictional-transformed-id"}',
          status: 200,
        });

        const provider = postmarkEmailLayer({
          serverToken: Redacted.make("fictional-unused-key"),
        }).pipe(Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.postmarkapp.com")));

        const receipt = yield* Email.pipe(
          Effect.flatMap((email) =>
            email.send(message, {
              executionMetadata: {
                nested: {
                  at: DateTime.makeUnsafe("2026-01-02T03:04:05.123Z"),
                  detail: "private-nested-wire-value",
                },
                tenant: "private-tenant",
              },
            }),
          ),
          Effect.provide(
            transformedEmailLayer(provider, ({ message: input, options }) =>
              Effect.succeed({
                ...input,
                subject:
                  options.executionMetadata?.tenant === "private-tenant"
                    ? "Tenant notification"
                    : "Wrong tenant",
              }),
            ),
          ),
        );

        assert(EmailReceiptSchema.guards.Accepted(receipt));
        const request = yield* Queue.take(fixture.received);

        const wire = yield* Schema.decodeEffect(
          Schema.fromJsonString(Schema.Struct({ Subject: Schema.String, TextBody: Schema.String })),
        )(request.body);

        assert.strictEqual(wire.Subject, "Tenant notification");
        assert.strictEqual(wire.TextBody, "Original");
        assert.notInclude(request.body, "private-tenant");
        assert.notInclude(request.body, "private-nested-wire-value");
        assert.notInclude(request.body, "executionMetadata");
      }).pipe(Effect.scoped),
  );

  it.effect(
    "retries an eligible rejection with the same rendered intent rather than invoking middleware again",
    () =>
      Effect.gen(function* retainRenderingAcrossRetries() {
        const ordinal = yield* Ref.make(0);
        const waiting = yield* Deferred.make<boolean>();
        const release = yield* Deferred.make<boolean>();

        const fixture = yield* startEmailHttpFixture({
          body: '{"name":"rate_limit_exceeded","message":"private-provider-description"}',
          next: { body: '{"id":"fictional-transformed-id"}', status: 200 },
          status: 429,
        });

        const provider = resendEmailLayer(
          { apiKey: Redacted.make("fictional-unused-key") },
          policy,
          () =>
            Deferred.succeed(waiting, true).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.asVoid,
            ),
        ).pipe(Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.resend.com")));

        const layer = transformedEmailLayer(provider, ({ message: input }) =>
          Ref.getAndUpdate(ordinal, (value) => value + 1).pipe(
            Effect.map((value) => ({ ...input, subject: `Rendering ${value}` })),
          ),
        );

        yield* Effect.gen(function* executeTransformedRetry() {
          const fiber = yield* (yield* Email).send(message).pipe(Effect.forkScoped);
          yield* Deferred.await(waiting);
          yield* TestClock.adjust("1 second");
          yield* Deferred.succeed(release, true);
          yield* TestClock.adjust("1 second");
          const receipt = yield* Fiber.join(fiber);
          assert(EmailReceiptSchema.guards.Accepted(receipt));
          const first = yield* Queue.take(fixture.received);
          const second = yield* Queue.take(fixture.received);
          assert.strictEqual(first.body, second.body);

          const wire = yield* Schema.decodeEffect(
            Schema.fromJsonString(Schema.Struct({ subject: Schema.String })),
          )(second.body);

          assert.strictEqual(wire.subject, "Rendering 0");
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped),
  );

  it.effect.each(["Defect", "Interrupt", "Invalid", "Compound"] as const)(
    "does not submit or ordinarily settle a middleware %s",
    (mode) =>
      Effect.gen(function* preserveTransformationFailure() {
        const entered = yield* Deferred.make<boolean>();

        const failure = new EmailInvalidMessage({
          issues: [{ path: "subject", problem: "Host refused content" }],
        });

        const outcomes = {
          Compound: Effect.fail(failure).pipe(
            Effect.ensuring(Effect.die("private-transform-finalizer-defect")),
          ),
          Defect: Effect.die("private-transform-defect"),
          Interrupt: Effect.never,
          Invalid: Effect.fail(failure),
        };

        const layer = transformedEmailLayer(recordingEmailLayer, () =>
          Deferred.succeed(entered, true).pipe(Effect.andThen(outcomes[mode])),
        ).pipe(Layer.provideMerge(recordingSenderLayer));

        yield* Effect.gen(function* executeFailedTransformation() {
          const fiber = yield* (yield* Email).sendAll([{ message }]).pipe(Effect.forkScoped);
          yield* Deferred.await(entered);

          if (mode === "Interrupt") {
            yield* Fiber.interrupt(fiber);
          }

          const exit = yield* Fiber.await(fiber);

          if (mode === "Invalid") {
            assert(Exit.isSuccess(exit));
            const [item] = exit.value;
            assert(item !== undefined && Result.isFailure(item));
            assert(item.failure instanceof EmailInvalidMessage);
            assert.strictEqual(item.failure.issues[0]?.path, "message.subject");
          } else {
            assert(Exit.isFailure(exit));
            assert.strictEqual(Exit.hasInterrupts(exit), mode === "Interrupt");
            assert.strictEqual(Exit.hasDies(exit), mode === "Defect" || mode === "Compound");
          }

          assert.deepStrictEqual(yield* (yield* RecordedEmails).messages, []);
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped),
  );

  it.effect(
    "owns recursive values, shared branches and native instants without mutating caller data or treating strings as dates",
    () =>
      Effect.gen(function* ownRecursiveExecutionData() {
        const native = DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-02T03:04:05.123Z"));
        const utc = DateTime.makeUnsafe("2026-01-02T03:04:05.456Z");
        const shared = { label: "private-shared-context" };

        const metadata = {
          explicitUndefined: undefined,
          left: shared,
          native,
          right: shared,
          text: "2026-01-02T03:04:05.123Z",
          utc,
          values: [0, false, null, undefined],
        };

        const keys = Object.keys(metadata);
        Object.setPrototypeOf(metadata, null);
        yield* Effect.gen(function* inspectOwnedRecursivePreview() {
          const operation = yield* (yield* Email).prepare(message, { executionMetadata: metadata });
          const context = operation.previews[0].options.executionMetadata;
          assert(
            Schema.is(
              Schema.Struct({
                explicitUndefined: Schema.Undefined,
                left: Schema.Struct({ label: Schema.String }),
                native: Schema.DateTimeUtc,
                right: Schema.Struct({ label: Schema.String }),
                text: Schema.String,
                utc: Schema.DateTimeUtc,
                values: Schema.Array(
                  Schema.Union([Schema.Number, Schema.Boolean, Schema.Null, Schema.Undefined]),
                ),
              }),
            )(context),
          );
          shared.label = "changed";
          native.setUTCFullYear(2030);
          Reflect.set(utc, "epochMilliseconds", 0);
          metadata.values[0] = 1;
          assert.strictEqual(context.left.label, "private-shared-context");
          assert.strictEqual(context.right.label, "private-shared-context");
          assert.notStrictEqual(context.left, context.right);
          assert.strictEqual(DateTime.formatIso(context.native), "2026-01-02T03:04:05.123Z");
          assert.strictEqual(DateTime.formatIso(context.utc), "2026-01-02T03:04:05.456Z");
          assert.strictEqual(context.text, "2026-01-02T03:04:05.123Z");
          assert.deepStrictEqual(context.values, [0, false, null, undefined]);
          assert(Object.hasOwn(context, "explicitUndefined"));
          assert(!Object.hasOwn(context, "omitted"));
          assert.deepStrictEqual(Object.keys(context), keys);
          assert.strictEqual(Reflect.set(context.left, "label", "tampered"), false);
          assert.strictEqual(Reflect.set(context.values, 0, 9), false);
          assert.strictEqual(Reflect.set(context.native, "epochMilliseconds", 0), false);
          assert(Object.isFrozen(DateTime.toPartsUtc(context.native)));

          const serialized = yield* Schema.encodeEffect(Schema.toCodecJson(EmailSendOptionsSchema))(
            operation.previews[0].options,
          ).pipe(Effect.result);

          assert(Result.isFailure(serialized));
          yield* operation.send;
          const recorded = yield* (yield* RecordedEmails).messages;
          assert.notInclude(JSON.stringify(recorded), "private-shared-context");
          assert.deepStrictEqual(recorded[0], operation.previews[0].message);
        }).pipe(Effect.provide(recordingEmailLayer.pipe(Layer.provideMerge(recordingSenderLayer))));
      }),
  );

  it.effect.each([
    "Cycle",
    "ArrayWidth",
    "Sparse",
    "Map",
    "Function",
    "BigInt",
    "Symbol",
    "Hidden",
    "Prototype",
    "InvalidUtc",
  ] as const)(
    "refuses %s context before callbacks/submission without retaining private diagnostics",
    (mode) =>
      Effect.gen(function* boundRecursiveContextBeforeCallbacks() {
        const trace = yield* startEmailTraceFixture();
        const metadata = { value: "private-recursive-context" };

        const corrupt = {
          ArrayWidth: () =>
            Reflect.set(
              metadata,
              "value",
              Array.from({ length: 33 }, () => true),
            ),
          BigInt: () => Reflect.set(metadata, "value", 1n),
          Cycle: () => Reflect.set(metadata, "value", metadata),
          Function: () => Reflect.set(metadata, "value", () => "private"),
          Hidden: () =>
            Object.defineProperty(metadata, "hidden", { enumerable: false, value: "private" }),
          InvalidUtc: () => {
            const instant = DateTime.makeUnsafe("2026-01-02T03:04:05.123Z");
            Reflect.set(instant, "epochMilliseconds", 8_640_000_000_000_001);
            Reflect.set(metadata, "value", instant);
          },
          Map: () => Reflect.set(metadata, "value", new Map([["private", "private"]])),
          Prototype: () => {
            Object.setPrototypeOf(metadata, { secret: "private" });
          },
          Sparse: () => {
            const values = ["private", "private"];
            Reflect.deleteProperty(values, 0);
            Reflect.set(metadata, "value", values);
          },
          Symbol: () => Reflect.set(metadata, "value", Symbol("private")),
        };

        corrupt[mode]();
        const callbacks = yield* Queue.unbounded<boolean>();

        const result = yield* Email.pipe(
          Effect.flatMap((email) => email.send(message, { executionMetadata: metadata })),
          Effect.provide(
            transformedEmailLayer(recordingEmailLayer, ({ message: input }) =>
              Queue.offer(callbacks, true).pipe(Effect.as(input)),
            ),
          ),
          Effect.withTracer(trace.tracer),
          Effect.result,
        );

        assert(Result.isFailure(result));
        assert(result.failure instanceof EmailInvalidOptions);
        assert.notInclude(JSON.stringify(result.failure), "private");
        assert.notInclude(yield* trace.diagnostics, "private");
        assert.strictEqual(yield* Queue.size(callbacks), 0);
      }),
  );

  it.effect.each([7, 8])(
    "bounds context depth before recursive decoding with %s nested records",
    (depth) =>
      Effect.gen(function* boundExecutionContextDepth() {
        let value: EmailExecutionMetadataInputValue = "private-leaf";

        for (let index = 0; index < depth; index += 1) {
          value = { child: value };
        }

        const result = yield* Email.pipe(
          Effect.flatMap((email) => email.prepare(message, { executionMetadata: { value } })),
          Effect.provide(recordingEmailLayer),
          Effect.result,
        );

        assert.strictEqual(Result.isSuccess(result), depth === 7);

        if (Result.isFailure(result)) {
          assert(result.failure instanceof EmailInvalidOptions);
          assert.notInclude(JSON.stringify(result.failure), "private-leaf");
        }
      }),
  );

  it.effect.each([29, 30])(
    "bounds total context expansion rather than only each container with %s extra leaves",
    (extraLeaves) =>
      Effect.gen(function* boundExecutionContextWork() {
        const branch = Object.fromEntries(
          Array.from({ length: 6 }, (_, index) => [`key${index}`, "private-value"]),
        );

        const result = yield* Email.pipe(
          Effect.flatMap((email) =>
            email.prepare(message, {
              executionMetadata: {
                extra: Array.from({ length: extraLeaves }, () => false),
                values: Array.from({ length: 32 }, () => branch),
              },
            }),
          ),
          Effect.provide(recordingEmailLayer),
          Effect.result,
        );

        assert.strictEqual(Result.isSuccess(result), extraLeaves === 29);

        if (Result.isFailure(result)) {
          assert(result.failure instanceof EmailInvalidOptions);
          assert.notInclude(JSON.stringify(result.failure), "private-value");
        }
      }),
  );

  it.effect.each(["Infinite", "InvalidDate", "Long", "Count", "Undefined", "Key"] as const)(
    "refuses %s execution metadata before middleware and does not expose its values",
    (mode) =>
      Effect.gen(function* rejectInvalidExecutionMetadata() {
        const invalid = {
          Count: Object.fromEntries(
            Array.from({ length: 33 }, (_, index) => [`key${index}`, "private-context-value"]),
          ),
          Infinite: { tenant: Number.POSITIVE_INFINITY },
          InvalidDate: { tenant: new Date(Number.NaN) },
          Key: { "private invalid key": "private-context-value" },
          Long: { tenant: "private-context-value".repeat(4096) },
          Undefined: undefined,
        };

        const calls = yield* Queue.unbounded<boolean>();
        const options = { executionMetadata: { tenant: "private-context-value" } };
        Reflect.set(options, "executionMetadata", invalid[mode]);

        const result = yield* Email.pipe(
          Effect.flatMap((email) =>
            Effect.all([
              email.send(message, options).pipe(Effect.flip),
              email
                .sendPersonalized(
                  {
                    message: { body: message.body, from: message.from, subject: message.subject },
                    recipients: [{ to: "recipient@example.test", variables: {} }],
                  },
                  options,
                )
                .pipe(Effect.flip),
            ]),
          ),
          Effect.provide(
            transformedEmailLayer(recordingEmailLayer, ({ message: input }) =>
              Queue.offer(calls, true).pipe(Effect.as(input)),
            ),
          ),
        );

        for (const failure of result) {
          assert(failure instanceof EmailInvalidOptions);
          assert.notInclude(JSON.stringify(failure), "private-context-value");
          assert.notInclude(JSON.stringify(failure), "private invalid key");
        }

        assert.strictEqual(yield* Queue.size(calls), 0);
      }),
  );

  it.effect(
    "keeps middleware inputs, execution metadata and original defects out of SDK span exits",
    () =>
      Effect.gen(function* minimizeTransformationDiagnostics() {
        const trace = yield* startEmailTraceFixture();

        const result = yield* Email.pipe(
          Effect.flatMap((email) =>
            email.send(
              { ...message, subject: "private-transform-subject" },
              { executionMetadata: { tenant: "private-tenant" } },
            ),
          ),
          Effect.provide(
            transformedEmailLayer(recordingEmailLayer, () =>
              Effect.die("private-transform-defect"),
            ),
          ),
          Effect.withTracer(trace.tracer),
          Effect.exit,
        );

        assert(Exit.hasDies(result));
        const diagnostics = yield* trace.diagnostics;
        assert.include(diagnostics, "Email.transform");

        for (const privateValue of [
          "private-transform-subject",
          "private-tenant",
          "private-transform-defect",
          "recipient@example.test",
        ]) {
          assert.notInclude(diagnostics, privateValue);
        }
      }),
  );
});
