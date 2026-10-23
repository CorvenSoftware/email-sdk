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
  Result,
  Schema,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { emailFixtureClientLayer, startEmailHttpFixture } from "../test/email-http-fixture.js";
import { startEmailTraceFixture } from "../test/email-tracing-fixture.js";
import { EmailConfigurationError } from "./email-configuration-error.js";
import { EmailDeliveryUnknown } from "./email-delivery-unknown.js";
import { EmailInvalidMessage } from "./email-invalid-message.js";
import { EmailInvalidOptions } from "./email-invalid-options.js";
import { EmailRejected } from "./email-rejected.js";
import { EmailReceiptSchema } from "./email-message.js";
import type { EmailMessageInput } from "./email-message.js";
import type { ResendBatchEmailResult } from "./resend-email-sender.js";
import {
  ResendBatchEmail,
  resendBatchEmailLayer,
  resendEmailLayer,
} from "./resend-email-sender.js";
import { Email } from "./email-service.js";

const message = {
  body: { html: "<p>private-body</p>", text: "private-body" },
  from: "sender@example.test",
  subject: "private-subject",
  to: ["recipient@example.test"],
} as const;

const localLayer = (url: string) =>
  resendBatchEmailLayer({ apiKey: Redacted.make("private-token") }).pipe(
    Layer.provide(emailFixtureClientLayer(url, "https://api.resend.com")),
  );

const WireMessages = Schema.Array(
  Schema.Struct({
    bcc: Schema.optionalKey(Schema.Array(Schema.String)),
    cc: Schema.optionalKey(Schema.Array(Schema.String)),
    from: Schema.String,
    headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    html: Schema.optionalKey(Schema.String),
    reply_to: Schema.optionalKey(Schema.Array(Schema.String)),
    subject: Schema.String,
    tags: Schema.optionalKey(
      Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
    ),
    text: Schema.optionalKey(Schema.String),
    to: Schema.Array(Schema.String),
  }),
);

const resultEvidence = (outcomes: readonly ResendBatchEmailResult[]) =>
  outcomes.map((outcome) => {
    if (Result.isFailure(outcome)) {
      return { kind: outcome.failure._tag, reason: outcome.failure.reason };
    }

    assert(EmailReceiptSchema.guards.Accepted(outcome.success));

    return {
      kind: "Accepted",
      messageId: String(outcome.success.messageId),
      provider: outcome.success.provider,
    };
  });

const unknownEvidence = { kind: "EmailDeliveryUnknown", reason: "invalid-response" } as const;

const acceptedEvidence = (messageId: string) => ({
  kind: "Accepted",
  messageId,
  provider: "resend",
});

describe("Resend native batch local HTTP", () => {
  it.effect(
    "submits one array request with a batch key and independently maps receipts by index",
    () =>
      Effect.gen(function* submitNativeResendBatch() {
        const fixture = yield* startEmailHttpFixture({
          body: '{"data":[{"id":"private-first"},{"id":"private-second"}]}',
          status: 200,
        });

        const modes = yield* Queue.unbounded<string | string[] | undefined>();
        fixture.server.on("request", (request) => {
          Queue.offerUnsafe(modes, request.headers["x-batch-validation"]);
        });

        const outcomes = yield* ResendBatchEmail.use((batch) =>
          batch.send(
            [
              {
                ...message,
                bcc: "hidden@example.test",
                cc: { address: "copy@example.test", name: "Copy" },
                from: { address: "sender@example.test", name: "Fictional Team" },
                headers: [{ name: "X-Workflow", value: "synthetic" }],
                replyTo: "reply@example.test",
                tags: [{ name: "workflow", value: "synthetic" }],
              },
              { ...message, body: { text: "second-body" }, subject: "Second" },
            ],
            { idempotencyKey: "private-batch-key" },
          ),
        ).pipe(Effect.provide(localLayer(fixture.url)));

        assert.deepStrictEqual(resultEvidence(outcomes), [
          acceptedEvidence("private-first"),
          acceptedEvidence("private-second"),
        ]);
        assert.isFrozen(outcomes);
        const request = yield* Queue.take(fixture.received);
        assert.strictEqual(yield* Queue.take(modes), "strict");
        assert.strictEqual(request.method, "POST");
        assert.strictEqual(request.path, "/emails/batch");
        assert.strictEqual(request.authorization, "Bearer private-token");
        assert.strictEqual(request.idempotencyKey, "private-batch-key");
        assert.include(request.contentType, "application/json");
        const wire = yield* Schema.decodeEffect(Schema.fromJsonString(WireMessages))(request.body);
        assert.deepStrictEqual(wire, [
          {
            bcc: ["hidden@example.test"],
            cc: ['"Copy" <copy@example.test>'],
            from: '"Fictional Team" <sender@example.test>',
            headers: { "X-Workflow": "synthetic" },
            html: "<p>private-body</p>",
            reply_to: ["reply@example.test"],
            subject: "private-subject",
            tags: [{ name: "workflow", value: "synthetic" }],
            text: "private-body",
            to: ["recipient@example.test"],
          },
          {
            from: "sender@example.test",
            subject: "Second",
            text: "second-body",
            to: ["recipient@example.test"],
          },
        ]);
        assert.notInclude(request.body, "idempotencyKey");
        assert.notInclude(request.body, "validation");
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );

  it.effect.each([1, 100])("accepts the native bound %i without splitting", (count) =>
    Effect.gen(function* submitNativeBatchBoundary() {
      const fixture = yield* startEmailHttpFixture({
        body: JSON.stringify({
          data: Array.from({ length: count }, (_, index) => ({ id: `fictional-${index}` })),
        }),
        status: 200,
      });

      const outcomes = yield* ResendBatchEmail.use((batch) =>
        batch.send([message, ...Array.from({ length: count - 1 }, () => message)]),
      ).pipe(Effect.provide(localLayer(fixture.url)));

      assert.strictEqual(outcomes.length, count);
      assert(outcomes.every(Result.isSuccess));
      const request = yield* Queue.take(fixture.received);
      assert.strictEqual(request.idempotencyKey, "");
      assert.strictEqual(
        (yield* Schema.decodeEffect(Schema.fromJsonString(WireMessages))(request.body)).length,
        count,
      );
      assert.strictEqual(yield* Queue.size(fixture.received), 0);
    }),
  );

  it.effect.each([0, 101])("rejects %i messages before transport", (count) =>
    Effect.gen(function* rejectNativeBatchBounds() {
      const fixture = yield* startEmailHttpFixture({ body: "{}", status: 200 });

      const inputs: [EmailMessageInput, ...EmailMessageInput[]] = [
        message,
        ...Array.from({ length: Math.max(0, count - 1) }, () => message),
      ];

      if (count === 0) {
        inputs.pop();
      }

      const failure = yield* ResendBatchEmail.use((batch) => batch.send(inputs)).pipe(
        Effect.provide(localLayer(fixture.url)),
        Effect.flip,
      );

      assert(failure instanceof EmailInvalidMessage);
      assert.strictEqual(yield* Queue.size(fixture.received), 0);
    }),
  );

  it.effect("preflights every position and rejects all unsupported intent before any request", () =>
    Effect.gen(function* rejectUnsupportedNativeBatchIntent() {
      const fixture = yield* startEmailHttpFixture({ body: "{}", status: 200 });

      const failure = yield* ResendBatchEmail.use((batch) =>
        batch.send([
          message,
          {
            ...message,
            attachments: [
              { contentBase64: "YQ==", contentType: "text/plain", filename: "private-file.txt" },
            ],
          },
          { ...message, metadata: { private: "private-value" } },
          { ...message, sendAt: "2099-01-01T00:00:00Z" },
          {
            ...message,
            headers: [
              { name: "X-Test", value: "one" },
              { name: "x-test", value: "two" },
            ],
          },
        ]),
      ).pipe(Effect.provide(localLayer(fixture.url)), Effect.flip);

      assert(failure instanceof EmailInvalidMessage);
      assert.deepStrictEqual(
        failure.issues.map(({ path }) => path),
        ["1.attachments", "2.metadata", "3.sendAt", "4.headers"],
      );
      assert.notInclude(JSON.stringify(failure), "private");
      assert.strictEqual(yield* Queue.size(fixture.received), 0);
    }),
  );

  it.effect("rejects extra message and per-item options rather than dropping them", () =>
    Effect.gen(function* rejectNativeBatchExtraFields() {
      const fixture = yield* startEmailHttpFixture({ body: "{}", status: 200 });

      const inputs = [
        { ...message, options: { idempotencyKey: "private-item-key" } },
        { ...message, privateField: "private-value" },
      ] satisfies [unknown, ...unknown[]];

      const failure = yield* ResendBatchEmail.use((batch) => batch.send(inputs)).pipe(
        Effect.provide(localLayer(fixture.url)),
        Effect.flip,
      );

      assert(failure instanceof EmailInvalidMessage);
      assert.notInclude(JSON.stringify(failure), "private");
      assert.strictEqual(yield* Queue.size(fixture.received), 0);
    }),
  );

  it.effect.each([
    { idempotencyKey: "x".repeat(257) },
    { idempotencyKey: "private key with spaces" },
    { idempotencyKey: "valid", policy: { maxAttempts: 2 } },
    { idempotencyKey: "valid", validationMode: "permissive" },
  ])("rejects invalid or unsupported batch options %#", (options) =>
    Effect.gen(function* rejectNativeBatchOptions() {
      const fixture = yield* startEmailHttpFixture({ body: "{}", status: 200 });

      const failure = yield* ResendBatchEmail.use((batch) => batch.send([message], options)).pipe(
        Effect.provide(localLayer(fixture.url)),
        Effect.flip,
      );

      assert(failure instanceof EmailInvalidOptions);
      assert.notInclude(JSON.stringify(failure), "private");
      assert.strictEqual(yield* Queue.size(fixture.received), 0);
    }),
  );

  it.effect("accepts a 256-character batch key and 50 total recipients but rejects 51", () =>
    Effect.gen(function* checkNativeBatchKeyAndRecipientBounds() {
      const fixture = yield* startEmailHttpFixture({
        body: '{"data":[{"id":"fictional-boundary"}]}',
        status: 200,
      });

      const recipients: [string, ...string[]] = [
        "recipient-0@example.test",
        ...Array.from({ length: 49 }, (_, index) => `recipient-${index + 1}@example.test`),
      ];

      yield* ResendBatchEmail.use((batch) =>
        Effect.gen(function* submitBoundedNativeBatchRecipients() {
          const outcomes = yield* batch.send([{ ...message, to: recipients }], {
            idempotencyKey: "x".repeat(256),
          });

          assert.deepStrictEqual(resultEvidence(outcomes), [
            acceptedEvidence("fictional-boundary"),
          ]);

          const failure = yield* batch
            .send([{ ...message, bcc: "extra@example.test", to: recipients }])
            .pipe(Effect.flip);

          assert(failure instanceof EmailInvalidMessage);
        }),
      ).pipe(Effect.provide(localLayer(fixture.url)));
      assert.strictEqual((yield* Queue.take(fixture.received)).idempotencyKey.length, 256);
      assert.strictEqual(yield* Queue.size(fixture.received), 0);
    }),
  );

  it.effect.each([
    {
      data: [{ id: "one" }, { id: 42 }, { id: "three" }],
      expected: [acceptedEvidence("one"), unknownEvidence, acceptedEvidence("three")],
    },
    {
      data: [{ id: "one" }],
      expected: [acceptedEvidence("one"), unknownEvidence, unknownEvidence],
    },
    {
      data: [{ id: "same" }, { id: "same" }, { id: "three" }],
      expected: [unknownEvidence, unknownEvidence, acceptedEvidence("three")],
    },
    {
      data: [{ error: "private-error", id: "same" }, { id: "same" }, { id: "three" }],
      expected: [unknownEvidence, unknownEvidence, acceptedEvidence("three")],
    },
    {
      data: [null, {}, { id: "bad id" }],
      expected: [unknownEvidence, unknownEvidence, unknownEvidence],
    },
    { data: [], expected: [unknownEvidence, unknownEvidence, unknownEvidence] },
  ])("preserves only independent per-index acknowledgement evidence %#", ({ data, expected }) =>
    Effect.gen(function* settleNativeBatchEvidence() {
      const fixture = yield* startEmailHttpFixture({ body: JSON.stringify({ data }), status: 200 });

      const outcomes = yield* ResendBatchEmail.use((batch) =>
        batch.send([message, message, message]),
      ).pipe(Effect.provide(localLayer(fixture.url)));

      assert.deepStrictEqual(resultEvidence(outcomes), expected);
      assert.strictEqual(yield* Queue.size(fixture.received), 1);
    }),
  );

  it.effect.each([
    '{"data":[{"id":"one"}],"errors":[{"index":0,"message":"private-error"}]}',
    '{"data":[{"id":"one"},{"id":"extra"}]}',
    '{"data":{}}',
    '{"id":"private-not-a-batch"}',
    "private-not-json",
    `"${"x".repeat(65_536)}"`,
  ])("refuses malformed or ambiguous envelopes without manufactured acceptance %#", (body) =>
    Effect.gen(function* rejectAmbiguousNativeBatchEnvelope() {
      const fixture = yield* startEmailHttpFixture({ body, status: 200 });

      const failure = yield* ResendBatchEmail.use((batch) => batch.send([message])).pipe(
        Effect.provide(localLayer(fixture.url)),
        Effect.flip,
      );

      assert(failure instanceof EmailDeliveryUnknown);
      assert.strictEqual(failure.reason, "invalid-response");
      assert.notInclude(JSON.stringify(failure), "private");
      assert.strictEqual(yield* Queue.size(fixture.received), 1);
    }),
  );

  it.effect.each([
    {
      body: '{"name":"invalid_idempotent_request","message":"private-error"}',
      reason: "idempotency-conflict",
      status: 409,
      tag: "EmailRejected",
    },
    {
      body: '{"name":"concurrent_idempotent_requests","message":"private-error"}',
      reason: "idempotency-in-progress",
      status: 409,
      tag: "EmailDeliveryUnknown",
    },
    {
      body: '{"message":"private-error"}',
      reason: "invalid-message",
      status: 422,
      tag: "EmailRejected",
    },
    {
      body: '{"message":"private-error"}',
      reason: "authentication",
      status: 401,
      tag: "EmailRejected",
    },
    {
      body: '{"name":"validation_error","message":"private-error"}',
      reason: "invalid-message",
      status: 403,
      tag: "EmailRejected",
    },
    {
      body: '{"name":"restricted_api_key","message":"private-error"}',
      reason: "authentication",
      status: 403,
      tag: "EmailRejected",
    },
    {
      body: "private-malformed-error",
      reason: "authentication",
      status: 403,
      tag: "EmailRejected",
    },
    {
      body: '{"name":"rate_limit_exceeded","message":"private-error"}',
      reason: "rate-limited",
      status: 429,
      tag: "EmailRejected",
    },
    {
      body: '{"name":"daily_quota_exceeded","message":"private-error"}',
      reason: "rejected",
      status: 429,
      tag: "EmailRejected",
    },
    {
      body: '{"name":"monthly_quota_exceeded","message":"private-error"}',
      reason: "rejected",
      status: 429,
      tag: "EmailRejected",
    },
    {
      body: "private-malformed-error",
      reason: "rejected",
      status: 429,
      tag: "EmailRejected",
    },
    {
      body: '{"message":"private-error"}',
      reason: "server-error",
      status: 503,
      tag: "EmailDeliveryUnknown",
    },
    {
      body: '{"message":"private-error"}',
      reason: "unexpected-status",
      status: 408,
      tag: "EmailDeliveryUnknown",
    },
    { body: "{}", reason: "unexpected-status", status: 307, tag: "EmailDeliveryUnknown" },
  ])("makes no retry or fallback after $status/$reason", (scenario) =>
    Effect.gen(function* classifyNativeBatchFailureWithoutReplay() {
      const fixture = yield* startEmailHttpFixture({
        ...scenario,
        location: "https://api.resend.com/forbidden",
        next: { body: '{"data":[{"id":"must-not-submit"}]}', status: 200 },
      });

      const failure = yield* ResendBatchEmail.use((batch) =>
        batch.send([message], { idempotencyKey: "private-key" }),
      ).pipe(Effect.provide(localLayer(fixture.url)), Effect.flip);

      assert(failure instanceof EmailDeliveryUnknown || failure instanceof EmailRejected);
      assert.strictEqual(failure._tag, scenario.tag);
      assert.strictEqual(failure.reason, scenario.reason);
      assert.notInclude(JSON.stringify(failure), "private");
      assert.strictEqual(yield* Queue.size(fixture.received), 1);
    }),
  );

  it.effect("owns every message and the key before transport can suspend", () =>
    Effect.gen(function* ownNativeBatchBeforeTransport() {
      const fixture = yield* startEmailHttpFixture({
        body: '{"data":[{"id":"one"},{"id":"two"}]}',
        status: 200,
      });

      const entered = yield* Deferred.make<boolean>();

      const release = yield* Deferred.make<boolean>();

      const native = yield* HttpClient.HttpClient.pipe(
        Effect.provide(emailFixtureClientLayer(fixture.url, "https://api.resend.com")),
      );

      const client = HttpClient.make((request) =>
        Deferred.succeed(entered, true).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(native.execute(request)),
        ),
      );

      const inputs = [
        { ...message, body: { text: "original-first" }, to: ["first@example.test"] },
        { ...message, body: { text: "original-second" }, to: ["second@example.test"] },
      ] satisfies [EmailMessageInput, ...EmailMessageInput[]];

      const options = { idempotencyKey: "original-key" };

      const fiber = yield* ResendBatchEmail.use((batch) => batch.send(inputs, options)).pipe(
        Effect.provide(
          resendBatchEmailLayer({ apiKey: Redacted.make("private-token") }).pipe(
            Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
          ),
        ),
        Effect.forkScoped,
      );

      yield* Deferred.await(entered);

      for (const input of inputs) {
        assert.isFalse(Object.isFrozen(input.body));
        input.body.text = "mutated";
        input.to.push("mutated@example.test");
      }

      inputs.pop();
      options.idempotencyKey = "mutated-key";
      yield* Deferred.succeed(release, true);
      assert.strictEqual((yield* Fiber.join(fiber)).length, 2);
      const request = yield* Queue.take(fixture.received);
      assert.strictEqual(request.idempotencyKey, "original-key");
      assert.notInclude(request.body, "mutated");
      assert.include(request.body, "original-first");
      assert.include(request.body, "original-second");
    }),
  );

  it.effect(
    "interrupts held transport and closes the physical request without settling acceptance",
    () =>
      Effect.gen(function* interruptNativeBatchTransport() {
        const fixture = yield* startEmailHttpFixture({ body: "{}", hold: true, status: 200 });

        const fiber = yield* ResendBatchEmail.use((batch) => batch.send([message])).pipe(
          Effect.provide(localLayer(fixture.url)),
          Effect.forkScoped,
        );

        yield* Queue.take(fixture.received);
        yield* Fiber.interrupt(fiber);
        const exit = yield* Fiber.await(fiber);
        assert(Exit.isFailure(exit));
        assert(Cause.hasInterrupts(exit.cause));
        assert.strictEqual(yield* Queue.take(fixture.closed), true);
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );

  it.effect("keeps result identifiers, inputs, keys and provider errors out of tracing", () =>
    Effect.gen(function* protectNativeBatchDiagnostics() {
      const trace = yield* startEmailTraceFixture();

      const fixture = yield* startEmailHttpFixture({
        body: '{"data":[{"id":"private-id"}]}',
        next: {
          body: '{"name":"invalid_idempotent_request","message":"private-error"}',
          status: 409,
        },
        status: 200,
      });

      yield* ResendBatchEmail.use((batch) =>
        Effect.gen(function* submitPrivateNativeBatchInputs() {
          yield* batch.send([message], { idempotencyKey: "private-key" });
          yield* batch.send([message], { idempotencyKey: "private-key" }).pipe(Effect.result);
        }),
      ).pipe(Effect.provide(localLayer(fixture.url)), Effect.withTracer(trace.tracer));
      const diagnostics = yield* trace.diagnostics;
      assert.include(diagnostics, "ResendBatch.send");
      assert.notInclude(diagnostics, "private");
      assert.notInclude(diagnostics, "recipient@example.test");
      assert.notInclude(diagnostics, "http.request");
    }),
  );

  for (const service of ["ordinary", "native"] as const) {
    for (const stage of ["transport", "HTTP200 body", "HTTP409 body"] as const) {
      for (const secondary of ["defect", "interruption"] as const) {
        it.effect(`preserves compound HTTP ${secondary} for ${service} at ${stage}`, () =>
          Effect.gen(function* preserveCompoundHttpSubmissionCause() {
            const trace = yield* startEmailTraceFixture();
            const entered = yield* Deferred.make<boolean>();
            const defect = new Error("private-compound-http-defect");
            const interruptor = 123_456;
            let attempts = 0;

            const client = HttpClient.make((request) =>
              Effect.gen(function* failCompoundHttpRequest() {
                attempts += 1;
                yield* Deferred.succeed(entered, true);

                const response = HttpClientResponse.fromWeb(
                  request,
                  new Response("", {
                    status: stage === "HTTP409 body" ? 409 : 200,
                  }),
                );

                const failure = new HttpClientError.HttpClientError({
                  reason:
                    stage === "transport"
                      ? new HttpClientError.TransportError({
                          cause: "private-transport-failure",
                          request,
                        })
                      : new HttpClientError.DecodeError({
                          cause: "private-body-failure",
                          request,
                          response,
                        }),
                });

                const cause = Cause.combine(
                  Cause.fail(failure),
                  secondary === "defect" ? Cause.die(defect) : Cause.interrupt(interruptor),
                );

                if (stage === "transport") {
                  return yield* Effect.failCause(cause);
                }

                Object.defineProperty(response, "stream", { value: Stream.failCause(cause) });

                return response;
              }),
            );

            const transport = Layer.succeed(HttpClient.HttpClient, client);

            const operation =
              service === "ordinary"
                ? Email.use((email) =>
                    email.send(message, { idempotencyKey: "private-compound-key" }),
                  ).pipe(
                    Effect.provide(
                      resendEmailLayer(
                        { apiKey: Redacted.make("private-token") },
                        {
                          deadline: Duration.seconds(5),
                          initialDelay: Duration.millis(1),
                          maxAttempts: 3,
                        },
                      ).pipe(Layer.provide(transport)),
                    ),
                    Effect.asVoid,
                  )
                : ResendBatchEmail.use((batch) =>
                    batch.send([message], { idempotencyKey: "private-compound-key" }),
                  ).pipe(
                    Effect.provide(
                      resendBatchEmailLayer({ apiKey: Redacted.make("private-token") }).pipe(
                        Layer.provide(transport),
                      ),
                    ),
                    Effect.asVoid,
                  );

            const fiber = yield* operation.pipe(
              Effect.withTracer(trace.tracer),
              Effect.exit,
              Effect.forkScoped,
            );

            yield* Deferred.await(entered);
            yield* TestClock.adjust(Duration.seconds(5));
            const exit = yield* Fiber.join(fiber);
            assert(Exit.isFailure(exit));

            if (secondary === "defect") {
              assert(
                exit.cause.reasons.some(
                  (reason) => Cause.isDieReason(reason) && reason.defect === defect,
                ),
              );
            } else {
              assert(
                exit.cause.reasons.some(
                  (reason) => Cause.isInterruptReason(reason) && reason.fiberId === interruptor,
                ),
              );
            }

            assert.strictEqual(attempts, 1);
            const diagnostics = yield* trace.diagnostics;
            assert.notInclude(diagnostics, "private");
            assert.notInclude(diagnostics, "recipient@example.test");
            assert.notInclude(diagnostics, "http.request");
          }),
        );
      }
    }
  }

  it.effect("preserves transport defects instead of turning them into failed batch items", () =>
    Effect.gen(function* preserveNativeBatchTransportDefect() {
      const trace = yield* startEmailTraceFixture();

      const exit = yield* ResendBatchEmail.use((batch) => batch.send([message])).pipe(
        Effect.provide(
          resendBatchEmailLayer({ apiKey: Redacted.make("private-token") }).pipe(
            Layer.provide(
              Layer.succeed(
                HttpClient.HttpClient,
                HttpClient.make(() => Effect.die("private-defect")),
              ),
            ),
          ),
        ),
        Effect.withTracer(trace.tracer),
        Effect.exit,
      );

      assert(Exit.isFailure(exit));
      assert(Cause.hasDies(exit.cause));
      assert.notInclude(yield* trace.diagnostics, "private");
    }),
  );

  it.effect("reports transport uncertainty without another request", () =>
    Effect.gen(function* preserveNativeBatchTransportUncertainty() {
      let attempts = 0;

      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          attempts += 1;
        }).pipe(
          Effect.andThen(
            Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({
                  cause: "private-transport-error",
                  request,
                }),
              }),
            ),
          ),
        ),
      );

      const failure = yield* ResendBatchEmail.use((batch) =>
        batch.send([message], { idempotencyKey: "private-key" }),
      ).pipe(
        Effect.provide(
          resendBatchEmailLayer({ apiKey: Redacted.make("private-token") }).pipe(
            Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
          ),
        ),
        Effect.flip,
      );

      assert(failure instanceof EmailDeliveryUnknown);
      assert.strictEqual(failure.reason, "transport");
      assert.strictEqual(attempts, 1);
      assert.notInclude(JSON.stringify(failure), "private");
    }),
  );

  it.effect("validates redacted credentials at acquisition without transport", () =>
    Effect.gen(function* rejectNativeBatchConfiguration() {
      const fixture = yield* startEmailHttpFixture({ body: "{}", status: 200 });

      const failure = yield* ResendBatchEmail.pipe(
        Effect.provide(
          resendBatchEmailLayer({ apiKey: Redacted.make("private invalid token") }).pipe(
            Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.resend.com")),
          ),
        ),
        Effect.flip,
      );

      assert(failure instanceof EmailConfigurationError);
      assert.notInclude(JSON.stringify(failure), "private");
      assert.strictEqual(yield* Queue.size(fixture.received), 0);
    }),
  );
});
