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
  Result,
  Schema,
} from "effect";
import { TestClock } from "effect/testing";
import type { EmailRetryDecision, EmailRetryCandidate } from "./index.js";
import { emailFixtureClientLayer, startEmailHttpFixture } from "../test/email-http-fixture.js";
import {
  Email,
  emailAttachmentFromBytes,
  EmailConfigurationError,
  EmailDeliveryUnknown,
  EmailInvalidMessage,
  EmailSender,
  parseEmailMessage,
  EmailReceiptSchema,
  EmailRejected,
} from "./index.js";
import {
  preflightResendEmail,
  resendEmailLayer,
  resendSenderLayer,
} from "./resend-email-sender.js";

const startHttpFixture = startEmailHttpFixture;

const localHttpClientLayer = (url: string) =>
  emailFixtureClientLayer(url, "https://api.resend.com");

const message = {
  body: { html: "<p>Fictional &amp; welcome</p>", text: "Fictional café & welcome" },
  from: "sender@example.test",
  subject: "Synthetic wire example",
  to: ["recipient@example.test"],
} as const;

const ReceivedEmail = Schema.Struct({
  attachments: Schema.Array(
    Schema.Struct({
      content: Schema.String,
      content_id: Schema.optionalKey(Schema.String),
      content_type: Schema.String,
      filename: Schema.String,
    }),
  ),
  bcc: Schema.Array(Schema.String),
  cc: Schema.Array(Schema.String),
  from: Schema.String,
  headers: Schema.Record(Schema.String, Schema.String),
  html: Schema.String,
  reply_to: Schema.Array(Schema.String),
  scheduled_at: Schema.String,
  subject: Schema.String,
  tags: Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
  text: Schema.String,
  to: Schema.Array(Schema.String),
});

describe("Resend local HTTP wire", () => {
  it.effect(
    "preflights owned provider intent without transport authority, then uses ordinary submission",
    () =>
      Effect.gen(function* inspectThenSubmitResendIntent() {
        const input = { ...message, body: { text: "original-preflight-body" } };

        const preview = yield* preflightResendEmail(input, {
          executionMetadata: { private: "private-inspection-context" },
          idempotencyKey: "preflight-event",
        });

        input.body.text = "changed";
        assert.strictEqual(preview.body.text, "original-preflight-body");
        assert(Object.isFrozen(preview.body));

        const fixture = yield* startHttpFixture({
          body: '{"id":"fictional-preflight-id"}',
          status: 200,
        });

        const receipt = yield* Email.pipe(
          Effect.flatMap((email) => email.send(preview, { idempotencyKey: "preflight-event" })),
          Effect.provide(
            resendEmailLayer({ apiKey: Redacted.make("fictional-unused-key") }).pipe(
              Layer.provide(localHttpClientLayer(fixture.url)),
            ),
          ),
        );

        assert(EmailReceiptSchema.guards.Accepted(receipt));
        const request = yield* Queue.take(fixture.received);
        assert.include(request.body, "original-preflight-body");
        assert.notInclude(request.body, "private-inspection-context");
      }).pipe(Effect.scoped),
  );
  it.effect.each([1, 2_592_000_000])(
    "preserves a native Date at the future scheduling boundary %i milliseconds ahead",
    (aheadMillis) =>
      Effect.gen(function* preserveResendScheduleBoundary() {
        const fixture = yield* startHttpFixture({ body: '{"id":"scheduled-id"}', status: 200 });
        const sendAt = DateTime.toDateUtc(DateTime.makeUnsafe(aheadMillis));

        yield* Email.use((email) => email.send({ ...message, sendAt })).pipe(
          Effect.provide(
            resendEmailLayer({ apiKey: Redacted.make("fictional-token") }).pipe(
              Layer.provide(localHttpClientLayer(fixture.url)),
            ),
          ),
        );

        const wire = yield* Schema.decodeEffect(
          Schema.fromJsonString(Schema.Struct({ scheduled_at: Schema.String })),
        )((yield* Queue.take(fixture.received)).body);

        assert.strictEqual(wire.scheduled_at, DateTime.formatIso(DateTime.makeUnsafe(aheadMillis)));
      }),
  );

  it.effect.each([-1, 0, 2_592_000_001])(
    "refuses a schedule %i milliseconds ahead at preflight, send and direct submission without HTTP",
    (aheadMillis) =>
      Effect.gen(function* rejectResendScheduleBoundary() {
        const fixture = yield* startHttpFixture({ body: '{"id":"unused"}', status: 200 });

        const senderLayer = resendSenderLayer({ apiKey: Redacted.make("fictional-token") }).pipe(
          Layer.provide(localHttpClientLayer(fixture.url)),
        );

        const input = { ...message, sendAt: DateTime.makeUnsafe(aheadMillis) };

        yield* Effect.gen(function* rejectResendSchedulePreflight() {
          const email = yield* Email;

          for (const operation of [
            email.validate(input).pipe(Effect.asVoid),
            email.send(input).pipe(Effect.asVoid),
          ]) {
            const failure = yield* operation.pipe(Effect.flip);
            assert(failure instanceof EmailInvalidMessage);
            assert.deepStrictEqual(
              failure.issues.map(({ path }) => path),
              ["sendAt"],
            );
          }
        }).pipe(
          Effect.provide(
            resendEmailLayer({ apiKey: Redacted.make("fictional-token") }).pipe(
              Layer.provide(localHttpClientLayer(fixture.url)),
            ),
          ),
        );

        const failure = yield* Effect.gen(function* rejectDirectResendSchedule() {
          const sender = yield* EmailSender;

          return yield* sender.submit({ message: yield* parseEmailMessage(input) });
        }).pipe(Effect.provide(senderLayer), Effect.flip);

        assert(failure instanceof EmailRejected);
        assert.strictEqual(failure.reason, "invalid-message");
        assert.notProperty(failure, "status");
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );

  it.effect(
    "rechecks a validated schedule at direct submission rather than moving expired intent",
    () =>
      Effect.gen(function* expireValidatedResendSchedule() {
        const fixture = yield* startHttpFixture({ body: '{"id":"unused"}', status: 200 });

        const senderLayer = resendSenderLayer({ apiKey: Redacted.make("fictional-token") }).pipe(
          Layer.provide(localHttpClientLayer(fixture.url)),
        );

        const failure = yield* Effect.gen(function* submitExpiredResendSchedule() {
          const sender = yield* EmailSender;
          const parsed = yield* parseEmailMessage({ ...message, sendAt: DateTime.makeUnsafe(1) });
          yield* sender.validate(parsed);
          yield* TestClock.adjust(1);

          return yield* sender.submit({ message: parsed });
        }).pipe(Effect.provide(senderLayer), Effect.flip);

        assert(failure instanceof EmailRejected);
        assert.strictEqual(failure.reason, "invalid-message");
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );
  it.effect(
    "a convenience Layer retry restriction vetoes a definite rejection before notification or another HTTP request",
    () =>
      Effect.gen(function* vetoResendRetry() {
        const fixture = yield* startHttpFixture({
          body: '{"name":"rate_limit_exceeded","message":"private-provider-description"}',
          next: { body: '{"id":"private-provider-id"}', status: 200 },
          retryAfter: "2",
          status: 429,
        });

        const offered: EmailRetryCandidate[] = [];
        const notified: EmailRetryDecision[] = [];

        const result = yield* Effect.gen(function* submitVetoedResendMessage() {
          return yield* (yield* Email).send(message);
        }).pipe(
          Effect.provide(
            resendEmailLayer(
              { apiKey: Redacted.make("private-key") },
              undefined,
              (decision) =>
                Effect.sync(() => {
                  notified.push(decision);
                }),
              (decision) =>
                Effect.sync(() => {
                  offered.push(decision);

                  return false;
                }),
            ).pipe(Layer.provide(localHttpClientLayer(fixture.url))),
          ),
          Effect.result,
        );

        assert(Result.isFailure(result));
        assert(result.failure instanceof EmailRejected);
        assert.strictEqual(result.failure.reason, "rate-limited");
        assert.strictEqual(offered.length, 1);
        assert.strictEqual(offered[0]?.delayMillis, 2000);
        assert.isFrozen(offered[0]);
        assert.notInclude(JSON.stringify(offered), "private");
        assert.strictEqual(notified.length, 0);
        assert.strictEqual(yield* Queue.size(fixture.received), 1);
      }),
  );

  it.effect(
    "the convenience Layer awaits a safe rate-limit retry decision and preserves provider backoff",
    () =>
      Effect.gen(function* observeResendRetryDecision() {
        const fixture = yield* startHttpFixture({
          body: '{"name":"rate_limit_exceeded","message":"private-provider-description"}',
          next: { body: '{"id":"private-provider-id"}', status: 200 },
          retryAfter: "2",
          status: 429,
        });

        const entered = yield* Deferred.make<boolean>();
        const decisions: EmailRetryDecision[] = [];

        const fiber = yield* Effect.gen(function* sendObservedResendMessage() {
          return yield* (yield* Email).send(message);
        }).pipe(
          Effect.provide(
            resendEmailLayer(
              { apiKey: Redacted.make("private-key") },
              { deadline: Duration.seconds(5), initialDelay: Duration.millis(1), maxAttempts: 2 },
              (decision) =>
                Effect.sync(() => {
                  decisions.push(decision);
                }).pipe(Effect.andThen(Deferred.succeed(entered, true)), Effect.asVoid),
            ).pipe(Layer.provide(localHttpClientLayer(fixture.url))),
          ),
          Effect.forkScoped,
        );

        yield* Deferred.await(entered);
        yield* Queue.take(fixture.received);
        yield* TestClock.adjust(1000);
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
        yield* TestClock.adjust(1000);
        const receipt = yield* Fiber.join(fiber);
        assert.strictEqual(receipt._tag, "Accepted");
        assert.strictEqual(yield* Queue.size(fixture.received), 1);
        const [decision] = decisions;
        assert.isDefined(decision);
        assert.strictEqual(decisions.length, 1);
        assert.strictEqual(decision.provider, "resend");
        assert.strictEqual(decision.reason, "rate-limited");
        assert.strictEqual(decision.delayMillis, 2000);
        assert.notInclude(JSON.stringify(decisions), "private");
      }),
  );
  it.effect(
    "submits the complete common message with credentials/key and returns only acknowledgement evidence",
    () =>
      Effect.gen(function* observeResendSubmission() {
        yield* TestClock.setTime(
          DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-13T12:00:00Z")),
        );

        const fixture = yield* startHttpFixture({
          body: '{"id":"provider-message-1"}',
          status: 200,
        });

        const program = Effect.gen(function* sendWireMessage() {
          const binary = yield* emailAttachmentFromBytes(new Uint8Array([0, 255, 128, 10]), {
            contentType: "application/octet-stream",
            filename: "sample.dat",
          });

          const text = yield* emailAttachmentFromBytes(new TextEncoder().encode("Fictional café"), {
            contentId: "inline-text",
            contentType: "text/plain",
            disposition: "inline",
            filename: "sample.txt",
          });

          return yield* (yield* Email).send(
            {
              ...message,
              attachments: [binary, text],
              bcc: "hidden@example.test",
              cc: { address: "copy@example.test", name: "Fictional Copy" },
              from: '"Fictional, \\"Team\\"" <sender@example.test>',
              headers: [{ name: "X-Workflow", value: "synthetic" }],
              replyTo: "reply@example.test",
              sendAt: "2026-10-13T18:00:00+05:30",
              tags: [{ name: "workflow", value: "synthetic" }],
              to: { address: "recipient@example.test", name: "Fictional Recipient" },
            },
            { idempotencyKey: "notification/event-1" },
          );
        });

        const receipt = yield* program.pipe(
          Effect.provide(
            resendEmailLayer({ apiKey: Redacted.make("fictional-token") }).pipe(
              Layer.provide(localHttpClientLayer(fixture.url)),
            ),
          ),
        );

        const received = yield* Queue.take(fixture.received);

        const payload = yield* Schema.decodeEffect(Schema.fromJsonString(ReceivedEmail))(
          received.body,
        );

        assert.strictEqual(received.method, "POST");
        assert.strictEqual(received.path, "/emails");
        assert.strictEqual(received.authorization, "Bearer fictional-token");
        assert.strictEqual(received.idempotencyKey, "notification/event-1");
        assert.strictEqual(payload.from, '"Fictional, \\"Team\\"" <sender@example.test>');
        assert.deepStrictEqual(payload.to, ['"Fictional Recipient" <recipient@example.test>']);
        assert.deepStrictEqual(payload.cc, ['"Fictional Copy" <copy@example.test>']);
        assert.deepStrictEqual(payload.bcc, ["hidden@example.test"]);
        assert.deepStrictEqual(payload.reply_to, ["reply@example.test"]);
        assert.strictEqual(payload.text, "Fictional café & welcome");
        assert.strictEqual(payload.html, "<p>Fictional &amp; welcome</p>");
        assert.strictEqual(payload.headers["X-Workflow"], "synthetic");
        assert.strictEqual(payload.scheduled_at, "2026-10-13T12:30:00.000Z");
        assert.deepStrictEqual(payload.tags, [{ name: "workflow", value: "synthetic" }]);
        const [binary, text] = payload.attachments;
        assert.isDefined(binary);
        assert.isDefined(text);
        assert.strictEqual(payload.attachments.length, 2);
        assert.deepStrictEqual([...Buffer.from(binary.content, "base64")], [0, 255, 128, 10]);
        assert.strictEqual(binary.filename, "sample.dat");
        assert.strictEqual(binary.content_type, "application/octet-stream");
        assert.strictEqual(Buffer.from(text.content, "base64").toString("utf-8"), "Fictional café");
        assert.strictEqual(text.filename, "sample.txt");
        assert.strictEqual(text.content_type, "text/plain");
        assert.strictEqual(text.content_id, "inline-text");
        assert.strictEqual(binary.content_id, undefined);
        assert(EmailReceiptSchema.guards.Accepted(receipt));
        assert.strictEqual(String(receipt.messageId), "provider-message-1");
        assert.strictEqual(receipt.provider, "resend");
      }),
  );

  it.live.each([
    {
      body: '{"id":42,"message":"private recipient"}',
      reason: "invalid-response",
      status: 200,
      uncertain: true,
    },
    {
      body: '{"name":"missing_api_key","message":"private token"}',
      reason: "authentication",
      status: 401,
      uncertain: false,
    },
    {
      body: '{"name":"daily_quota_exceeded","message":"private account"}',
      reason: "rejected",
      status: 429,
      uncertain: false,
    },
    {
      body: '{"name":"invalid_idempotent_request","message":"private payload"}',
      reason: "idempotency-conflict",
      status: 409,
      uncertain: false,
    },
    {
      body: '{"name":"application_error","message":"private details"}',
      reason: "server-error",
      status: 503,
      uncertain: true,
    },
  ])(
    "classifies $status/$reason without claiming non-submission or exposing provider bodies",
    (scenario) =>
      Effect.gen(function* classifyWireFailure() {
        const fixture = yield* startHttpFixture(scenario);

        const outcome = yield* Effect.gen(function* submitRejectedMessage() {
          return yield* (yield* Email).send(message);
        }).pipe(
          Effect.provide(
            resendEmailLayer({ apiKey: Redacted.make("fictional-token") }).pipe(
              Layer.provide(localHttpClientLayer(fixture.url)),
            ),
          ),
          Effect.result,
        );

        assert(Result.isFailure(outcome));

        if (scenario.uncertain) {
          assert(Schema.is(EmailDeliveryUnknown)(outcome.failure));
        } else {
          assert(Schema.is(EmailRejected)(outcome.failure));
        }

        assert(
          Schema.is(EmailDeliveryUnknown)(outcome.failure) ||
            Schema.is(EmailRejected)(outcome.failure),
        );
        assert.strictEqual(outcome.failure.reason, scenario.reason);
        assert.notInclude(JSON.stringify(outcome.failure), "private");
        assert.strictEqual(yield* Queue.size(fixture.received), 1);
      }),
  );

  it.live.each([
    { key: "private credential with spaces", label: "whitespace" },
    { key: "private\u0000credential", label: "control byte" },
  ])(
    "rejects $label in redacted credentials at Layer acquisition without a provider request",
    ({ key }) =>
      Effect.gen(function* rejectInvalidCredential() {
        const fixture = yield* startHttpFixture({ body: '{"id":"not-used"}', status: 200 });

        const error = yield* Effect.service(Email).pipe(
          Effect.provide(
            resendEmailLayer({ apiKey: Redacted.make(key) }).pipe(
              Layer.provide(localHttpClientLayer(fixture.url)),
            ),
          ),
          Effect.flip,
        );

        assert(Schema.is(EmailConfigurationError)(error));
        assert.strictEqual(error.issues[0]?.path, "apiKey");
        assert.notInclude(JSON.stringify(error), "private");
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );
});
