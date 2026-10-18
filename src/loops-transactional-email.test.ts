import { assert, describe, it } from "@effect/vitest";
import {
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
  Tracer,
} from "effect";
import { HttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import { emailFixtureClientLayer, startEmailHttpFixture } from "../test/email-http-fixture.js";
import type { EmailHttpFixture } from "../test/email-http-fixture.js";
import { startEmailTraceFixture } from "../test/email-tracing-fixture.js";
import {
  EmailConfigurationError,
  EmailDeliveryUnknown,
  EmailInvalidMessage,
  EmailInvalidOptions,
  EmailReceiptSchema,
  EmailRejected,
} from "./index.js";
import { LoopsTransactionalEmail, loopsTransactionalLayer } from "./loops-transactional-email.js";

const configuration = {
  apiKey: Redacted.make("private-loops-key"),
  attachments: "AccountEnabled",
  templateAuthority: "ProviderManaged",
} as const;

const job = {
  email: "recipient@fictional.invalid",
  transactionalId: "fictional_published_template",
} as const;

const policy = {
  deadline: Duration.seconds(5),
  initialDelay: Duration.millis(100),
  maxAttempts: 3,
};

const fixtureLoopsLayer = (fixture: EmailHttpFixture) =>
  loopsTransactionalLayer(configuration, policy).pipe(
    Layer.provide(emailFixtureClientLayer(fixture.url, "https://app.loops.so")),
  );

const Scalar = Schema.Union([Schema.String, Schema.Finite]);

const Wire = Schema.Struct({
  addToAudience: Schema.Boolean,
  attachments: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ contentType: Schema.String, data: Schema.String, filename: Schema.String }),
    ),
  ),
  dataVariables: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Union([Scalar, Schema.Array(Schema.Record(Schema.String, Scalar))]),
    ),
  ),
  email: Schema.String,
  transactionalId: Schema.String,
});

const submitJob = (input = job) =>
  Effect.gen(function* sendNativeLoopsJob() {
    return yield* (yield* LoopsTransactionalEmail).send(input);
  });

describe("Loops native transactional template jobs", () => {
  it.live("an explicit retry observer cannot promote forwarded keys or uncertainty to replay", () =>
    Effect.gen(function* preserveObservedLoopsReplayAuthority() {
      const fixture = yield* startEmailHttpFixture({
        body: '{"success":false,"message":"private-provider-description"}',
        status: 503,
      });

      const notifications = yield* Ref.make(0);
      const restrictions = yield* Ref.make(0);

      const result = yield* Effect.gen(function* submitObservedLoopsUnknown() {
        return yield* (yield* LoopsTransactionalEmail).send(job, { idempotencyKey: "private-key" });
      }).pipe(
        Effect.provide(
          loopsTransactionalLayer(
            configuration,
            policy,
            () => Ref.update(notifications, (count) => count + 1),
            () => Ref.update(restrictions, (count) => count + 1).pipe(Effect.as(true)),
          ).pipe(Layer.provide(emailFixtureClientLayer(fixture.url, "https://app.loops.so"))),
        ),
        Effect.result,
      );

      assert(Result.isFailure(result) && result.failure instanceof EmailDeliveryUnknown);
      assert.strictEqual(yield* Queue.size(fixture.received), 1);
      assert.strictEqual(yield* Ref.get(notifications), 0);
      assert.strictEqual(yield* Ref.get(restrictions), 0);
    }),
  );
  it.live(
    "sends the chosen remote template, unchanged scalar/array variables and independent MIME/bytes without adding an audience contact",
    () =>
      Effect.gen(function* inspectLoopsWire() {
        const fixture = yield* startEmailHttpFixture({ body: '{"success":true}', status: 200 });

        const input = {
          ...job,
          attachments: [
            {
              contentBase64: "AP+ACg==",
              contentType: "application/pdf",
              disposition: "attachment",
              filename: "invoice.pdf",
            },
            { contentBase64: "AQID", contentType: "image/png", filename: "picture.png" },
          ],
          dataVariables: {
            Name: 'Café 😀 {{literal}} <&>"\\\n',
            empty: "",
            items: [
              { amount: 0, title: "One" },
              { amount: 2.5, title: "二" },
              { amount: -1, title: "{DATA_VARIABLE:name}" },
            ],
            zero: 0,
          },
        } as const;

        const receipt = yield* Effect.gen(function* sendRichLoopsJob() {
          return yield* (yield* LoopsTransactionalEmail).send(input, {
            idempotencyKey: "unchanged-native-key",
          });
        }).pipe(Effect.provide(fixtureLoopsLayer(fixture)));

        assert(EmailReceiptSchema.guards.Accepted(receipt));
        assert.strictEqual(receipt.provider, "loops");
        assert.isUndefined(receipt.messageId);
        Reflect.set(receipt, "provider", "private-mutated-provider");
        assert.strictEqual(receipt.provider, "loops");
        const sent = yield* Queue.take(fixture.received);
        assert.strictEqual(sent.method, "POST");
        assert.strictEqual(sent.path, "/api/v1/transactional");
        assert.strictEqual(sent.authorization, "Bearer private-loops-key");
        assert.strictEqual(sent.idempotencyKey, "unchanged-native-key");
        assert.include(sent.contentType, "application/json");

        const wire = yield* Schema.decodeEffect(Schema.fromJsonString(Wire), {
          onExcessProperty: "error",
        })(sent.body);

        assert.strictEqual(wire.transactionalId, input.transactionalId);
        assert.strictEqual(wire.email, input.email);
        assert.isFalse(wire.addToAudience);
        assert.deepStrictEqual(wire.dataVariables, input.dataVariables);
        assert.isDefined(wire.attachments);
        const [first, second] = wire.attachments;
        assert.isDefined(first);
        assert.isDefined(second);
        assert.strictEqual(first.filename, "invoice.pdf");
        assert.strictEqual(first.contentType, "application/pdf");
        assert.deepStrictEqual([...Buffer.from(first.data, "base64")], [0, 255, 128, 10]);
        assert.strictEqual(second.filename, "picture.png");
        assert.strictEqual(second.contentType, "image/png");
        assert.deepStrictEqual([...Buffer.from(second.data, "base64")], [1, 2, 3]);
      }),
  );

  it.live(
    "omits optional variables/files/key instead of inventing empty content or correlation",
    () =>
      Effect.gen(function* inspectMinimalLoopsJob() {
        const fixture = yield* startEmailHttpFixture({ body: '{"success":true}', status: 200 });
        yield* submitJob().pipe(Effect.provide(fixtureLoopsLayer(fixture)));
        const sent = yield* Queue.take(fixture.received);

        const wire = yield* Schema.decodeEffect(Schema.fromJsonString(Wire), {
          onExcessProperty: "error",
        })(sent.body);

        assert.isUndefined(wire.dataVariables);
        assert.isUndefined(wire.attachments);
        assert.strictEqual(sent.idempotencyKey, "");
        assert.isFalse(wire.addToAudience);
      }),
  );

  it.live(
    "validation returns deeply owned template data and files without HTTP or account discovery",
    () =>
      Effect.gen(function* ownNativeLoopsJob() {
        const fixture = yield* startEmailHttpFixture({ body: '{"success":true}', status: 200 });
        const item = { amount: 0, title: "original" };
        const variables = { items: [item] as const, name: "original-name" };

        const attachment = {
          contentBase64: "AQID",
          contentType: "application/pdf",
          filename: "original.pdf",
        };

        const input = { ...job, attachments: [attachment], dataVariables: variables };

        const owned = yield* Effect.gen(function* validateThenSendLoopsSnapshot() {
          const loops = yield* LoopsTransactionalEmail;
          const prepared = yield* loops.validate({ ...input, attachments: [attachment] });
          assert.strictEqual(yield* Queue.size(fixture.received), 0);
          Reflect.set(item, "title", "private-mutated-title");
          Reflect.set(variables, "name", "private-mutated-name");
          Reflect.set(attachment, "filename", "private-mutated.pdf");
          Reflect.set(input, "transactionalId", "private-other-template");
          Reflect.set(prepared, "email", "private-other@fictional.invalid");
          const preparedVariables = prepared.dataVariables;
          assert.isDefined(preparedVariables);
          Reflect.set(preparedVariables, "name", "private-owned-mutation");
          const { items } = preparedVariables;
          assert(Schema.is(Schema.NonEmptyArray(Schema.Record(Schema.String, Scalar)))(items));
          Reflect.set(items, 0, { title: "private-replacement" });
          const [firstItem] = items;
          assert.isDefined(firstItem);
          Reflect.set(firstItem, "title", "private-nested-mutation");
          yield* loops.send(prepared);

          return prepared;
        }).pipe(Effect.provide(fixtureLoopsLayer(fixture)));

        const sent = yield* Queue.take(fixture.received);
        const wire = yield* Schema.decodeEffect(Schema.fromJsonString(Wire))(sent.body);
        assert.strictEqual(wire.email, job.email);
        assert.strictEqual(wire.transactionalId, job.transactionalId);
        assert.deepStrictEqual(wire.dataVariables, {
          items: [{ amount: 0, title: "original" }],
          name: "original-name",
        });
        assert.strictEqual(wire.attachments?.[0]?.filename, "original.pdf");
        assert.strictEqual(String(owned.email), job.email);
      }),
  );

  it.live(
    "bounds the complete expanded array data rather than multiplying independent record limits",
    () =>
      Effect.gen(function* boundLoopsArrayExpansion() {
        const fixture = yield* startEmailHttpFixture({ body: '{"success":true}', status: 200 });

        const rows = [
          { value: "synthetic" },
          ...Array.from({ length: 49 }, () => ({ value: "synthetic" })),
        ] as const;

        const variables = {
          ...Object.fromEntries(
            Array.from({ length: 20 }, (_, index) => [`items${index}`, rows] as const),
          ),
          ...Object.fromEntries(
            Array.from({ length: 24 }, (_, index) => [`scalar${index}`, index] as const),
          ),
        };

        yield* Effect.gen(function* sendBoundedLoopsArray() {
          const loops = yield* LoopsTransactionalEmail;
          yield* loops.send({ ...job, dataVariables: variables });

          const overflow = yield* loops
            .send({ ...job, dataVariables: { ...variables, extra: 0 } })
            .pipe(Effect.result);

          assert(Result.isFailure(overflow) && overflow.failure instanceof EmailInvalidMessage);
        }).pipe(Effect.provide(fixtureLoopsLayer(fixture)));
        const sent = yield* Queue.take(fixture.received);
        const wire = yield* Schema.decodeEffect(Schema.fromJsonString(Wire))(sent.body);
        assert.deepStrictEqual(wire.dataVariables, variables);
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );

  it.live.each([
    { field: "from", value: "private-sender@fictional.invalid" },
    { field: "body", value: { html: "private-literal-body" } },
    { field: "subject", value: "private-subject" },
    { field: "cc", value: "private-copy@fictional.invalid" },
    { field: "sendAt", value: "2026-11-01T00:00:00Z" },
    { field: "addToAudience", value: true },
    { field: "email", value: [job.email] },
    { field: "email", value: { address: job.email, name: "private" } },
    { field: "email", value: "private@EXAMPLE.COM" },
    { field: "email", value: "private@test.com" },
    { field: "transactionalId", value: "private/path?query" },
    { field: "dataVariables", value: { private: true } },
    { field: "dataVariables", value: { private: null } },
    { field: "dataVariables", value: { private: Number.NaN } },
    { field: "dataVariables", value: { private: { nested: "not-an-array" } } },
    { field: "dataVariables", value: { private: [{ nested: ["private"] }] } },
    { field: "dataVariables", value: { private: "x".repeat(499) } },
    { field: "dataVariables", value: { private: '"'.repeat(250) } },
    { field: "dataVariables", value: { private: "\uD800" } },
    { field: "dataVariables", value: { "private.name": "x" } },
    {
      field: "dataVariables",
      value: Object.fromEntries(
        Array.from({ length: 65 }, (_, index) => [`variable${index}`, "x"]),
      ),
    },
    {
      field: "dataVariables",
      value: { private: Array.from({ length: 51 }, () => ({ value: "x" })) },
    },
    { field: "attachments", value: [] },
    {
      field: "attachments",
      value: [{ contentBase64: "AQID", contentType: "ProviderSelected", filename: "private.pdf" }],
    },
    {
      field: "attachments",
      value: [
        {
          contentBase64: "AQID",
          contentId: "private-cid",
          contentType: "image/png",
          filename: "private.png",
        },
      ],
    },
    {
      field: "attachments",
      value: [{ contentBase64: "AR==", contentType: "application/pdf", filename: "private.pdf" }],
    },
  ])(
    "refuses incompatible native intent before transport without echoing private data (case %#)",
    ({ field, value }) =>
      Effect.gen(function* refuseIncompatibleLoopsJob() {
        const fixture = yield* startEmailHttpFixture({ body: '{"success":true}', status: 200 });
        const input = { ...job };
        Reflect.set(input, field, value);

        const result = yield* submitJob(input).pipe(
          Effect.provide(fixtureLoopsLayer(fixture)),
          Effect.result,
        );

        assert(Result.isFailure(result) && result.failure instanceof EmailInvalidMessage);
        assert.notInclude(JSON.stringify(result.failure), "private");
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );

  it.live(
    "requires explicit attachment enablement instead of probing/changing account settings",
    () =>
      Effect.gen(function* requireLoopsAttachmentCapability() {
        const fixture = yield* startEmailHttpFixture({ body: '{"success":true}', status: 200 });

        const result = yield* Effect.gen(function* sendDisabledLoopsAttachment() {
          return yield* (yield* LoopsTransactionalEmail).send({
            ...job,
            attachments: [
              { contentBase64: "AQID", contentType: "application/pdf", filename: "file.pdf" },
            ],
          });
        }).pipe(
          Effect.provide(
            loopsTransactionalLayer({ ...configuration, attachments: "Disabled" }).pipe(
              Layer.provide(emailFixtureClientLayer(fixture.url, "https://app.loops.so")),
            ),
          ),
          Effect.result,
        );

        assert(Result.isFailure(result) && result.failure instanceof EmailInvalidMessage);
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );

  it.live.each([
    { field: "apiKey", value: "private-unwrapped-key" },
    { field: "apiKey", value: Redacted.make("private key") },
    { field: "apiKey", value: Redacted.make("") },
    { field: "templateAuthority", value: "UnmodifiedLiteralMessage" },
    { field: "templateAuthority", value: undefined },
    { field: "attachments", value: undefined },
    { field: "baseUrl", value: "https://private.invalid" },
  ])(
    "requires explicit safe construction without acquisition or HTTP (case %#)",
    ({ field, value }) =>
      Effect.gen(function* refuseLoopsConfiguration() {
        const fixture = yield* startEmailHttpFixture({ body: '{"success":true}', status: 200 });
        const options = { ...configuration };
        Reflect.set(options, field, value);

        const result = yield* Effect.service(LoopsTransactionalEmail).pipe(
          Effect.provide(
            loopsTransactionalLayer(options).pipe(
              Layer.provide(emailFixtureClientLayer(fixture.url, "https://app.loops.so")),
            ),
          ),
          Effect.result,
        );

        assert(Result.isFailure(result) && result.failure instanceof EmailConfigurationError);
        assert.notInclude(JSON.stringify(result.failure), "private");
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );

  it.live(
    "bounds unchanged keys and options locally, while caller mutations cannot widen service authority",
    () =>
      Effect.gen(function* defendLoopsOptions() {
        const fixture = yield* startEmailHttpFixture({ body: '{"success":true}', status: 200 });
        yield* Effect.gen(function* checkLoopsOptions() {
          const loops = yield* LoopsTransactionalEmail;
          Reflect.set(loops.idempotency, "maxKeyLength", 256);

          const tooLong = yield* loops
            .send(job, { idempotencyKey: "x".repeat(101) })
            .pipe(Effect.result);

          assert(Result.isFailure(tooLong) && tooLong.failure instanceof EmailRejected);
          assert.strictEqual(tooLong.failure.reason, "unsupported-idempotency");
          const invalidOptions = { extra: "private-value", idempotencyKey: "private-key" };
          const extra = yield* loops.send(job, invalidOptions).pipe(Effect.result);
          assert(Result.isFailure(extra) && extra.failure instanceof EmailInvalidOptions);

          const commonContext = {
            executionMetadata: { tenant: "private-context-value" },
            idempotencyKey: "private-key",
          };

          const context = yield* loops.send(job, commonContext).pipe(Effect.result);
          assert(Result.isFailure(context) && context.failure instanceof EmailInvalidOptions);
          assert.strictEqual(context.failure.issues[0]?.path, "executionMetadata");
          assert.notInclude(JSON.stringify(context.failure), "private-context-value");

          const invalidPolicy = yield* loops
            .send(job, { policy: { ...policy, maxAttempts: 0 } })
            .pipe(Effect.result);

          assert(
            Result.isFailure(invalidPolicy) && invalidPolicy.failure instanceof EmailInvalidOptions,
          );
          assert.strictEqual(yield* Queue.size(fixture.received), 0);
          yield* loops.send(job, { idempotencyKey: "x".repeat(100) });
        }).pipe(Effect.provide(fixtureLoopsLayer(fixture)));
        assert.strictEqual((yield* Queue.take(fixture.received)).idempotencyKey, "x".repeat(100));
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );

  it.live.each([
    { body: '{"success":false}', status: 200 },
    { body: '{"success":"true"}', status: 200 },
    { body: '{"success":true,"messageId":"private-invented-id"}', status: 200 },
    { body: '{"success":true,"error":"private-provider-reason"}', status: 200 },
    { body: "not-json-private", status: 200 },
    { body: JSON.stringify({ private: "x".repeat(65_536), success: true }), status: 200 },
    { body: '{"success":true}', status: 201 },
    { body: '{"success":true}', status: 202 },
    { body: '{"success":false,"message":"private-reason"}', status: 400 },
    { body: '{"success":false,"message":"private-reason"}', status: 401 },
    { body: '{"success":false,"message":"private-reason"}', status: 409 },
    { body: '{"success":false,"message":"private-reason"}', status: 429 },
    { body: '{"success":false,"message":"private-reason"}', status: 503 },
  ])(
    "keeps unreviewed or contradictory evidence unknown and does not replay forwarded keys (case %#)",
    ({ body, status }) =>
      Effect.gen(function* fenceLoopsUncertainty() {
        const fixture = yield* startEmailHttpFixture({ body, status });

        const result = yield* Effect.gen(function* sendUncertainLoopsJob() {
          return yield* (yield* LoopsTransactionalEmail).send(job, {
            idempotencyKey: "private-key",
          });
        }).pipe(Effect.provide(fixtureLoopsLayer(fixture)), Effect.result);

        assert(Result.isFailure(result) && result.failure instanceof EmailDeliveryUnknown);
        assert.notInclude(JSON.stringify(result.failure), "private");
        assert.strictEqual(yield* Queue.size(fixture.received), 1);
      }),
  );

  it.live(
    "keeps the documented different-body conflict terminal rather than reconstructing acceptance or retrying",
    () =>
      Effect.gen(function* inspectLoopsConflict() {
        const fixture = yield* startEmailHttpFixture({
          body: '{"success":false,"message":"Idempotency key already used with a different request body."}',
          status: 409,
        });

        yield* Effect.gen(function* sendConflictingLoopsJob() {
          const loops = yield* LoopsTransactionalEmail;

          const keyed = yield* loops
            .send(job, { idempotencyKey: "private-key" })
            .pipe(Effect.result);

          assert(Result.isFailure(keyed) && keyed.failure instanceof EmailRejected);
          assert.strictEqual(keyed.failure.reason, "idempotency-conflict");
          const unkeyed = yield* loops.send(job).pipe(Effect.result);
          assert(Result.isFailure(unkeyed) && unkeyed.failure instanceof EmailDeliveryUnknown);
        }).pipe(Effect.provide(fixtureLoopsLayer(fixture)));
        assert.strictEqual(yield* Queue.size(fixture.received), 2);
      }),
  );

  it.effect(
    "uses the operation deadline, cancels the socket and never retries a timed-out native job",
    () =>
      Effect.gen(function* deadlineLoopsJob() {
        const fixture = yield* startEmailHttpFixture({ body: "", hold: true, status: 200 });

        const fiber = yield* Effect.gen(function* sendSlowLoopsJob() {
          return yield* (yield* LoopsTransactionalEmail).send(job, {
            idempotencyKey: "private-key",
            policy: { ...policy, deadline: Duration.seconds(1) },
          });
        }).pipe(Effect.provide(fixtureLoopsLayer(fixture)), Effect.result, Effect.forkScoped);

        yield* Queue.take(fixture.received);
        yield* TestClock.adjust(Duration.seconds(1));
        const result = yield* Fiber.join(fiber);
        assert(Result.isFailure(result) && result.failure instanceof EmailDeliveryUnknown);
        assert.strictEqual(result.failure.reason, "timeout");
        assert.isTrue(yield* Queue.take(fixture.closed));
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );

  it.live(
    "caller interruption closes the request and preserves interruption rather than typed retry",
    () =>
      Effect.gen(function* interruptLoopsJob() {
        const fixture = yield* startEmailHttpFixture({ body: "", hold: true, status: 200 });

        const fiber = yield* submitJob().pipe(
          Effect.provide(fixtureLoopsLayer(fixture)),
          Effect.forkScoped,
        );

        yield* Queue.take(fixture.received);
        yield* Fiber.interrupt(fiber);
        assert(Exit.hasInterrupts(yield* Fiber.await(fiber)));
        assert.isTrue(yield* Queue.take(fixture.closed));
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );

  it.live("does not follow redirects beneath native submission policy", () =>
    Effect.gen(function* refuseLoopsRedirect() {
      const target = yield* startEmailHttpFixture({ body: '{"success":true}', status: 200 });

      const fixture = yield* startEmailHttpFixture({
        body: "",
        location: `${target.url}/private-target`,
        status: 307,
      });

      const result = yield* submitJob().pipe(
        Effect.provide(fixtureLoopsLayer(fixture)),
        Effect.result,
      );

      assert(Result.isFailure(result) && result.failure instanceof EmailDeliveryUnknown);
      assert.strictEqual(yield* Queue.size(fixture.received), 1);
      assert.strictEqual(yield* Queue.size(target.received), 0);
    }),
  );

  it.live.each([200, 503])(
    "excludes template IDs, variables, files, credentials and provider bodies from NativeSpan exits (status %s)",
    (status) =>
      Effect.gen(function* inspectLoopsPrivacy() {
        const fixture = yield* startEmailHttpFixture({
          body: status === 200 ? '{"success":true}' : '{"message":"private-provider-reason"}',
          status,
        });

        const trace = yield* startEmailTraceFixture();
        yield* Effect.gen(function* sendPrivateLoopsJob() {
          const loops = yield* LoopsTransactionalEmail;

          const input = {
            ...job,
            attachments: [
              {
                contentBase64: "cHJpdmF0ZS1ieXRlcw==",
                contentType: "text/plain",
                filename: "private-file.txt",
              },
            ],
            dataVariables: { value: "private-variable-value" },
          } as const;

          yield* loops.validate(input);

          return yield* loops.send(input, { idempotencyKey: "private-key" });
        }).pipe(
          Effect.provide(fixtureLoopsLayer(fixture)),
          Effect.provideService(Tracer.Tracer, trace.tracer),
          Effect.result,
        );
        const diagnostics = yield* trace.diagnostics;
        assert.include(diagnostics, "Loops.submit");
        assert.include(diagnostics, "Loops.validate");

        for (const privateValue of [
          job.email,
          job.transactionalId,
          "private-loops-key",
          "private-variable-value",
          "private-file.txt",
          "cHJpdmF0ZS1ieXRlcw==",
          "private-key",
          "private-provider-reason",
        ]) {
          assert.notInclude(diagnostics, privateValue);
        }
      }),
  );

  it.live(
    "enforces the actual UTF-8 JSON ceiling including Base64 files without truncating native data",
    () =>
      Effect.gen(function* boundLoopsWireBytes() {
        const fixture = yield* startEmailHttpFixture({ body: '{"success":true}', status: 200 });

        const first = {
          contentBase64: Buffer.alloc(1024 * 1024, 255).toString("base64"),
          contentType: "application/pdf",
          filename: "first.pdf",
        };

        const second = { ...first, filename: "second.pdf" };
        yield* Effect.gen(function* sendBoundedLoopsFiles() {
          const loops = yield* LoopsTransactionalEmail;
          yield* loops.send({ ...job, attachments: [first, second] });
          const measured = yield* Queue.take(fixture.received);
          const wire = yield* Schema.decodeEffect(Schema.fromJsonString(Wire))(measured.body);
          assert.isDefined(wire.attachments);
          const third = { contentType: "application/pdf", data: "", filename: "third.pdf" };

          const overhead = Buffer.byteLength(
            JSON.stringify({
              ...wire,
              attachments: [...wire.attachments, third],
              dataVariables: { padding: "" },
            }),
          );

          const available = 3_999_999 - overhead - Buffer.byteLength("界".repeat(50));
          const bytes = Math.floor(available / 4) * 3;
          const padding = `${"界".repeat(50)}${"x".repeat(available % 4)}`;

          const input = {
            ...job,
            attachments: [
              first,
              second,
              {
                contentBase64: Buffer.alloc(bytes, 128).toString("base64"),
                contentType: third.contentType,
                filename: third.filename,
              },
            ] as const,
            dataVariables: { padding },
          };

          yield* loops.send(input);
          const boundary = yield* Queue.take(fixture.received);
          assert.strictEqual(Buffer.byteLength(boundary.body), 3_999_999);
          const parsed = yield* Schema.decodeEffect(Schema.fromJsonString(Wire))(boundary.body);
          assert.strictEqual(parsed.attachments?.[2]?.data, input.attachments[2].contentBase64);

          const exceeded = yield* loops
            .send({ ...input, dataVariables: { padding: `${padding}x` } })
            .pipe(Effect.result);

          assert(Result.isFailure(exceeded) && exceeded.failure instanceof EmailInvalidMessage);
          assert.strictEqual(yield* Queue.size(fixture.received), 0);
        }).pipe(Effect.provide(fixtureLoopsLayer(fixture)));
      }),
  );

  it.live(
    "owns construction choices and captures transport rather than reacquiring operation-local clients",
    () =>
      Effect.gen(function* ownLoopsConstruction() {
        const fixture = yield* startEmailHttpFixture({ body: '{"success":true}', status: 200 });
        const options = { ...configuration };
        yield* Effect.gen(function* sendWithOwnedLoopsConstruction() {
          const loops = yield* LoopsTransactionalEmail;
          Reflect.set(options, "apiKey", Redacted.make("private-mutated-key"));
          Reflect.set(options, "attachments", "Disabled");
          yield* loops
            .send({
              ...job,
              attachments: [
                { contentBase64: "AQID", contentType: "text/plain", filename: "file.txt" },
              ],
            })
            .pipe(
              Effect.provideService(
                HttpClient.HttpClient,
                HttpClient.make(() => Effect.die("private-wrong-client")),
              ),
            );
        }).pipe(
          Effect.provide(
            loopsTransactionalLayer(options).pipe(
              Layer.provide(emailFixtureClientLayer(fixture.url, "https://app.loops.so")),
            ),
          ),
        );
        assert.strictEqual(
          (yield* Queue.take(fixture.received)).authorization,
          "Bearer private-loops-key",
        );
      }),
  );

  it.live(
    "preserves transport defects rather than converting them into retryable uncertainty",
    () =>
      Effect.gen(function* preserveLoopsDefect() {
        const trace = yield* startEmailTraceFixture();

        const result = yield* submitJob().pipe(
          Effect.provide(
            loopsTransactionalLayer(configuration).pipe(
              Layer.provide(
                Layer.succeed(
                  HttpClient.HttpClient,
                  HttpClient.make(() => Effect.die("private-transport-defect")),
                ),
              ),
            ),
          ),
          Effect.provideService(Tracer.Tracer, trace.tracer),
          Effect.exit,
        );

        assert(Exit.hasDies(result));
        assert.notInclude(yield* trace.diagnostics, "private-transport-defect");
      }),
  );
});
