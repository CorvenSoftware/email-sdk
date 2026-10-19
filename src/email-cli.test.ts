import { PassThrough, Readable } from "node:stream";
import { assert, describe, it } from "@effect/vitest";
import { DateTime, Deferred, Duration, Effect, Exit, Fiber, Layer, Queue, Schema } from "effect";
import { startEmailTraceFixture } from "../test/email-tracing-fixture.js";
import { EmailCliEnvironment } from "./email-cli-environment.js";
import { EmailCliError } from "./email-cli-error.js";
import { nodeEmailCliEnvironmentLayer } from "./email-cli-node.js";
import { EmailCli, emailCliLayer } from "./email-cli.js";
import { TestClock } from "effect/testing";
import {
  EmailSendOptionsSchema,
  EmailSendRequestSchema,
  prepareEmailSubmission,
} from "./email-preparation.js";

const message = {
  body: { text: "private-cli-content 🦉" },
  from: "sender@example.invalid",
  subject: "private-cli-subject",
  to: "recipient@example.invalid",
};

const requestLayer = (text: string) =>
  emailCliLayer.pipe(
    Layer.provide(
      Layer.succeed(EmailCliEnvironment, {
        readDistribution: Effect.die("Unexpected distribution read"),
        readRequest: Effect.succeed(text),
      }),
    ),
  );

const withCliRequest = (text: string, arguments_: readonly string[] = ["validate"]) =>
  Effect.gen(function* runCliRequest() {
    const cli = yield* EmailCli;

    return yield* cli.run(arguments_);
  }).pipe(Effect.provide(requestLayer(text)));

const parseFailure = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      error: Schema.Literal("EmailCliError"),
      reason: EmailCliError.fields.reason,
      submission: Schema.Literal("NotAttempted"),
    }),
  ),
);

const parseSuccess = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      authentication: Schema.Literal("NotChecked"),
      checks: Schema.Literal("CommonRequestOnly"),
      delivery: Schema.Literal("NotChecked"),
      providerPreflight: Schema.Literal("NotChecked"),
      submission: Schema.Literal("NotAttempted"),
      valid: Schema.Literal(true),
    }),
  ),
);

describe("offline email CLI", () => {
  it.effect.each(["sendgrid", "mailgun", "mailersend", "mailpace", "unosend"] as const)(
    "uses %s's real local constraints and key refusal without credentials",
    (provider) =>
      Effect.gen(function* checkExpandedProviderInspection() {
        const invalidMessages = {
          mailersend: { ...message, replyTo: ["first@example.test", "second@example.test"] },
          mailgun: {
            ...message,
            headers: [{ name: "X-Mailgun-Variables", value: "private-cli-override" }],
          },
          mailpace: {
            ...message,
            headers: [{ name: "X-Private", value: "private-cli-unsupported-header" }],
          },
          sendgrid: { ...message, metadata: {} },
          unosend: {
            ...message,
            attachments: [
              {
                contentBase64: "SGVsbG8=",
                contentType: "application/x-private",
                filename: "private.bin",
              },
            ],
          },
        };

        const valid = yield* withCliRequest(JSON.stringify({ message }), ["validate", provider]);
        assert.strictEqual(valid.exitCode, 0);

        const accepted = yield* Schema.decodeEffect(
          Schema.fromJsonString(
            Schema.Struct({
              authentication: Schema.Literal("NotChecked"),
              provider: Schema.String,
              providerPreflight: Schema.Literal("LocalOnly"),
              submission: Schema.Literal("NotAttempted"),
            }),
          ),
        )(valid.stdout);

        assert.strictEqual(accepted.provider, provider);

        const invalid = yield* withCliRequest(
          JSON.stringify({ message: invalidMessages[provider] }),
          ["validate", provider],
        );

        const keyed = yield* withCliRequest(
          JSON.stringify({ message, options: { idempotencyKey: "private-cli-key" } }),
          ["validate", provider],
        );

        for (const failure of [invalid, keyed]) {
          assert.strictEqual(failure.exitCode, 1);
          assert.strictEqual((yield* parseFailure(failure.stderr)).reason, "invalid-request");
          assert.notInclude(failure.stderr, "private");
        }
      }),
  );

  it.effect.each([0, 1, 1000, 259_200_001])(
    "preserves distinct SendGrid/MailerSend clock precision/window rules at %s milliseconds",
    (milliseconds) =>
      Effect.gen(function* inspectDistinctSchedulingProfiles() {
        const text = JSON.stringify({
          message: { ...message, sendAt: DateTime.formatIso(DateTime.makeUnsafe(milliseconds)) },
        });

        const sendgrid = yield* withCliRequest(text, ["validate", "sendgrid"]);
        const mailersend = yield* withCliRequest(text, ["validate", "mailersend"]);
        assert.strictEqual(sendgrid.exitCode, milliseconds === 1000 ? 0 : 1);
        assert.strictEqual(mailersend.exitCode, milliseconds <= 1000 ? 0 : 1);
      }),
  );
  it.effect.each(["Scheduling", "Metadata", "Key", "Mailbox"] as const)(
    "applies real provider-local %s constraints without acquiring credentials or HTTP",
    (mode) =>
      Effect.gen(function* compareOfflineProviderRules() {
        const requests = {
          Key: { message, options: { idempotencyKey: "private-cli-provider-key" } },
          Mailbox: {
            message: { ...message, from: { address: message.from, name: "n".repeat(240) } },
          },
          Metadata: { message: { ...message, metadata: { private: "private-cli-provider-data" } } },
          Scheduling: { message: { ...message, sendAt: "1970-01-02T00:00:00Z" } },
        };

        const text = JSON.stringify(requests[mode]);
        const resend = yield* withCliRequest(text, ["validate", "resend"]);
        const postmark = yield* withCliRequest(text, ["validate", "postmark"]);
        assert.strictEqual(resend.exitCode, mode === "Metadata" ? 1 : 0);
        assert.strictEqual(postmark.exitCode, mode === "Metadata" ? 0 : 1);
        const success = resend.exitCode === 0 ? resend : postmark;
        const failure = resend.exitCode === 1 ? resend : postmark;

        const report = yield* Schema.decodeEffect(
          Schema.fromJsonString(
            Schema.Struct({
              authentication: Schema.Literal("NotChecked"),
              checks: Schema.Literal("ProviderLocalPreflight"),
              delivery: Schema.Literal("NotChecked"),
              provider: Schema.Literals(["resend", "postmark"]),
              providerPreflight: Schema.Literal("LocalOnly"),
              submission: Schema.Literal("NotAttempted"),
              valid: Schema.Literal(true),
            }),
          ),
        )(success.stdout);

        assert.strictEqual(report.provider, mode === "Metadata" ? "postmark" : "resend");
        assert.strictEqual((yield* parseFailure(failure.stderr)).reason, "invalid-request");
        assert.notInclude(success.stdout + failure.stderr, "private-cli");
      }),
  );

  it.effect("rechecks Resend's moving scheduling window using Effect time", () =>
    Effect.gen(function* inspectOfflineScheduleAtExecution() {
      const text = JSON.stringify({ message: { ...message, sendAt: "1970-01-01T00:00:01Z" } });
      assert.strictEqual((yield* withCliRequest(text, ["validate", "resend"])).exitCode, 0);
      yield* TestClock.adjust("1 second");
      const expired = yield* withCliRequest(text, ["validate", "resend"]);
      assert.strictEqual((yield* parseFailure(expired.stderr)).reason, "invalid-request");
    }),
  );

  it.effect("preserves private-safe preflight spans and local policy/key refusal", () =>
    Effect.gen(function* inspectOfflineProviderPrivacy() {
      const trace = yield* startEmailTraceFixture();

      const parsed = yield* Schema.decodeEffect(EmailSendOptionsSchema)({
        executionMetadata: { nested: { value: "private-cli-context" } },
        idempotencyKey: "private-cli-key",
        policy: {
          deadline: Duration.millis(86_400_001),
          initialDelay: Duration.millis(100),
          maxAttempts: 2,
        },
      });

      const options = yield* Schema.encodeEffect(Schema.toCodecJson(EmailSendOptionsSchema))(
        parsed,
      );

      const text = JSON.stringify({ message, options });

      const report = yield* withCliRequest(text, ["validate", "resend"]).pipe(
        Effect.withTracer(trace.tracer),
      );

      assert.strictEqual((yield* parseFailure(report.stderr)).reason, "invalid-request");
      const diagnostics = yield* trace.diagnostics;
      assert.include(diagnostics, "Email.preflight");
      assert.notInclude(diagnostics, "private-cli");
      assert.notInclude(diagnostics, message.to);
    }),
  );
  it.effect("retains the recursive context work fence through the CLI JSON codec", () =>
    Effect.gen(function* boundCliExecutionContext() {
      const branch = Object.fromEntries(
        Array.from({ length: 7 }, (_, index) => [`key${index}`, "private-cli-context"]),
      );

      const report = yield* withCliRequest(
        JSON.stringify({
          message,
          options: { executionMetadata: { values: Array.from({ length: 32 }, () => branch) } },
        }),
      );

      assert.strictEqual(report.exitCode, 1);
      assert.notInclude(report.stderr, "private-cli-context");
      const failure = yield* parseFailure(report.stderr);
      assert.strictEqual(failure.reason, "invalid-request");
    }),
  );
  it.effect(
    "accepts named addresses and an explicit scheduling offset without claiming provider validation",
    () =>
      Effect.gen(function* validateCliOffsetSchedule() {
        const report = yield* withCliRequest(
          JSON.stringify({
            message: {
              ...message,
              from: "Sender <sender@example.invalid>",
              sendAt: "2030-01-02T08:34:05.123+05:30",
            },
          }),
        );

        assert.strictEqual(report.exitCode, 0);
        yield* parseSuccess(report.stdout);
        assert.notInclude(report.stdout, "2030-");
      }),
  );
  it.effect(
    "validates a rich common request without returning content or claiming provider checks",
    () =>
      Effect.gen(function* verifyRichCliRequest() {
        const prepared = yield* prepareEmailSubmission(
          {
            ...message,
            attachments: [
              {
                contentBase64: "SGVsbG8=",
                contentType: "text/plain",
                filename: "private-cli-attachment.txt",
              },
            ],
            bcc: ["hidden@example.invalid"],
            headers: [{ name: "X-Private", value: "private-cli-header" }],
            metadata: { private: "private-cli-metadata" },
            sendAt: "2030-01-02T03:04:05.000Z",
            tags: [{ name: "private-cli-tag", value: "private-cli-value" }],
          },
          {
            executionMetadata: {
              nested: { value: "private-cli-context", values: [0, false, null] },
            },
            idempotencyKey: "private-cli-key",
          },
        );

        assert(prepared.submission.idempotencyKey !== undefined);

        const text = yield* Schema.encodeEffect(
          Schema.fromJsonString(Schema.toCodecJson(EmailSendRequestSchema)),
        )({
          message: prepared.submission.message,
          options: {
            idempotencyKey: prepared.submission.idempotencyKey,
            policy: {
              deadline: Duration.seconds(30),
              initialDelay: Duration.millis(100),
              maxAttempts: 3,
            },
          },
        });

        const report = yield* withCliRequest(text);
        assert.strictEqual(report.exitCode, 0);
        assert.strictEqual(report.stderr, "");
        yield* parseSuccess(report.stdout);
        assert(!JSON.stringify(report).includes("private-cli"));
        assert(!JSON.stringify(report).includes("example.invalid"));
      }),
  );

  for (const [name, input] of [
    ["missing body", { message: { ...message, body: {} } }],
    ["empty audience", { message: { ...message, to: [] } }],
    [
      "unknown private field",
      { message: { ...message, "private-cli-control": "private-cli-value" } },
    ],
    ["unknown options", { message, options: { "private-cli-key": "private-cli-value" } }],
    [
      "header injection",
      { message: { ...message, subject: "private-cli-value\r\nBcc: hidden@example.invalid" } },
    ],
    [
      "ambiguous attachment",
      {
        message: {
          ...message,
          attachments: [
            {
              contentBase64: "SGVsbG8=",
              contentType: "text/plain",
              disposition: "inline",
              filename: "private-cli.txt",
            },
          ],
        },
      },
    ],
    [
      "noncanonical attachment",
      {
        message: {
          ...message,
          attachments: [
            { contentBase64: "Zg", contentType: "text/plain", filename: "private-cli.txt" },
          ],
        },
      },
    ],
    ["impossible date", { message: { ...message, sendAt: "2030-02-30T00:00:00.000Z" } }],
    ["impossible offset date", { message: { ...message, sendAt: "2030-02-30T00:00:00+05:30" } }],
    ["unknown scheduling offset", { message: { ...message, sendAt: "2030-01-02T03:04:05-00:00" } }],
    [
      "unsafe policy",
      {
        message,
        options: {
          policy: {
            deadline: Schema.encodeSync(Schema.toCodecJson(Schema.Duration))(Duration.infinity),
            initialDelay: Schema.encodeSync(Schema.toCodecJson(Schema.Duration))(
              Duration.millis(100),
            ),
            maxAttempts: 3,
          },
        },
      },
    ],
  ] as const) {
    it.effect(`refuses ${name} without echoing rejected intent`, () =>
      Effect.gen(function* refuseInvalidCliRequest() {
        const report = yield* withCliRequest(JSON.stringify(input));
        assert.strictEqual(report.exitCode, 1);
        assert.strictEqual(report.stdout, "");
        assert.strictEqual((yield* parseFailure(report.stderr)).reason, "invalid-request");
        assert(!report.stderr.includes("private-cli"));
        assert(!report.stderr.includes("example.invalid"));
      }),
    );
  }

  for (const text of [
    "",
    "{private-cli",
    '{"message":{},"mess\\u0061ge":{}}',
    '{"message":{"body":{"text":"private-cli"},"body":{"html":"private-cli"}}}',
  ]) {
    it.effect("refuses malformed or decoded-duplicate JSON without exposing the document", () =>
      Effect.gen(function* refuseCliJson() {
        const report = yield* withCliRequest(text);
        assert.strictEqual(report.exitCode, 1);
        assert.strictEqual((yield* parseFailure(report.stderr)).reason, "invalid-json");
        assert(!report.stderr.includes("private-cli"));
      }),
    );
  }

  it.effect("rejects structural work before selected-field decoding", () =>
    Effect.gen(function* boundCliJsonWork() {
      const report = yield* withCliRequest(`${"[".repeat(33)}0${"]".repeat(33)}`);
      assert.strictEqual((yield* parseFailure(report.stderr)).reason, "input-limit");
    }),
  );

  it.effect(
    "does not read input or metadata for help/schema and refuses credential or sending flags",
    () =>
      Effect.gen(function* verifyOfflineCliCommands() {
        const cli = yield* EmailCli;

        for (const args of [[], ["help"], ["--help"]]) {
          const report = yield* cli.run(args);
          assert.strictEqual(report.exitCode, 0);
          assert(report.stdout.includes("NOT CHECKED"));
          assert(report.stdout.includes("piped stdin"));
        }

        const profiles = yield* cli.run(["providers"]);
        assert.strictEqual(profiles.exitCode, 0);

        const inventory = yield* Schema.decodeEffect(
          Schema.fromJsonString(
            Schema.Struct({
              coverage: Schema.Literal("SelectedProfiles"),
              providers: Schema.Array(
                Schema.Struct({
                  capabilities: Schema.Struct({
                    metadata: Schema.Boolean,
                    scheduling: Schema.Boolean,
                  }),
                  name: Schema.String,
                  preflight: Schema.Literal("LocalOnly"),
                }),
              ),
              submission: Schema.Literal("NotAttempted"),
            }),
          ),
        )(profiles.stdout);

        const selected = inventory.providers.find((provider) => provider.name === "postmark");
        assert.isDefined(selected);
        assert.strictEqual(selected.capabilities.scheduling, false);
        assert.strictEqual(selected.capabilities.metadata, true);
        const schema = yield* cli.run(["schema"]);

        const document = yield* Schema.decodeEffect(
          Schema.fromJsonString(
            Schema.Struct({
              constraints: Schema.Literal("PartialProjection"),
              document: Schema.Json,
              validationAuthority: Schema.Literal("corven-email validate"),
            }),
          ),
        )(schema.stdout);

        assert.strictEqual(document.constraints, "PartialProjection");

        for (const args of [
          ["send"],
          ["auth"],
          ["doctor"],
          ["--dry-run"],
          ["validate", "--api-key", "private-cli-credential"],
          ["private-cli-command"],
          ["validate", "loops"],
          ["validate", "private-cli-provider"],
          ["validate", "resend", "private-cli-extra"],
          ["providers", "resend"],
        ]) {
          const report = yield* cli.run(args);
          assert.strictEqual(report.exitCode, 2);
          assert.strictEqual((yield* parseFailure(report.stderr)).reason, "usage");
          assert(!report.stderr.includes("private-cli"));
        }
      }).pipe(
        Effect.provide(
          emailCliLayer.pipe(
            Layer.provide(
              Layer.succeed(EmailCliEnvironment, {
                readDistribution: Effect.die("Unexpected distribution read"),
                readRequest: Effect.die("Unexpected stdin read"),
              }),
            ),
          ),
        ),
      ),
  );

  it.effect(
    "discovers installed entrypoints from validated metadata without leaking unrelated fields",
    () =>
      Effect.gen(function* discoverCliEntrypoints() {
        const cli = yield* EmailCli;
        const report = yield* cli.run(["discover"]);
        assert.strictEqual(report.exitCode, 0);

        const data = yield* Schema.decodeEffect(
          Schema.fromJsonString(
            Schema.Struct({ entrypoints: Schema.Array(Schema.String), version: Schema.String }),
          ),
        )(report.stdout);

        assert.deepStrictEqual(data.entrypoints, [".", "./native-job"]);
        assert.strictEqual(data.version, "2.3.4");
        assert(!report.stdout.includes("private-cli"));
        assert(!report.stdout.includes("./package.json"));
      }).pipe(
        Effect.provide(
          emailCliLayer.pipe(
            Layer.provide(
              Layer.succeed(EmailCliEnvironment, {
                readDistribution: Effect.succeed(
                  JSON.stringify({
                    exports: {
                      ".": "./private-cli-root.js",
                      "./native-job": "./private-cli-file.js",
                      "./package.json": "./package.json",
                    },
                    name: "@corvencore/email-sdk",
                    private: "private-cli-secret",
                    version: "2.3.4",
                  }),
                ),
                readRequest: Effect.die("Unexpected stdin read"),
              }),
            ),
          ),
        ),
      ),
  );

  for (const text of [
    '{"name":"private-cli-name"}',
    '{"name":"@corvencore/email-sdk","version":"private-cli-version","exports":{}}',
    '{"name":"@corvencore/email-sdk","version":"1.0.0","exports":{"./private_cli_path":"private-cli-value"}}',
  ]) {
    it.effect("reports unusable distribution metadata safely", () =>
      Effect.gen(function* refuseCliMetadata() {
        const cli = yield* EmailCli;
        const report = yield* cli.run(["discover"]);
        assert.strictEqual((yield* parseFailure(report.stderr)).reason, "distribution-unavailable");
        assert(!report.stderr.includes("private-cli"));
      }).pipe(
        Effect.provide(
          emailCliLayer.pipe(
            Layer.provide(
              Layer.succeed(EmailCliEnvironment, {
                readDistribution: Effect.succeed(text),
                readRequest: Effect.die("Unexpected stdin read"),
              }),
            ),
          ),
        ),
      ),
    );
  }

  it.effect("preserves defects without retaining private causes in SDK-owned spans", () =>
    Effect.gen(function* preserveCliDefect() {
      const trace = yield* startEmailTraceFixture();
      const cli = yield* EmailCli;
      const exit = yield* cli.run(["validate"]).pipe(Effect.withTracer(trace.tracer), Effect.exit);
      assert(Exit.hasDies(exit));
      assert(!(yield* trace.diagnostics).includes("private-cli"));
    }).pipe(
      Effect.provide(
        emailCliLayer.pipe(
          Layer.provide(
            Layer.succeed(EmailCliEnvironment, {
              readDistribution: Effect.die("Unexpected distribution read"),
              readRequest: Effect.die("private-cli-defect"),
            }),
          ),
        ),
      ),
    ),
  );

  it.effect(
    "caller interruption stops pending input rather than returning a rejection report",
    () =>
      Effect.gen(function* interruptCliRead() {
        const started = yield* Deferred.make<boolean>();
        const released = yield* Deferred.make<boolean>();

        const environment = Layer.succeed(EmailCliEnvironment, {
          readDistribution: Effect.die("Unexpected distribution read"),
          readRequest: Deferred.succeed(started, true).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(released, true)),
          ),
        });

        const fiber = yield* Effect.gen(function* waitForCliInput() {
          const cli = yield* EmailCli;

          return yield* cli.run(["validate"]);
        }).pipe(Effect.provide(emailCliLayer.pipe(Layer.provide(environment))), Effect.forkScoped);

        yield* Deferred.await(started);
        yield* Fiber.interrupt(fiber);
        assert(Exit.hasInterrupts(yield* Fiber.await(fiber)));
        assert(yield* Deferred.await(released));
      }),
  );

  it.effect.prop(
    "generated escaped content crosses JSON/common validation without becoming diagnostic output",
    { content: Schema.NonEmptyString.check(Schema.isMaxLength(150)) },
    ({ content }) =>
      Effect.gen(function* validateGeneratedCliContent() {
        const report = yield* withCliRequest(
          JSON.stringify({ message: { ...message, body: { text: `private-cli-${content}` } } }),
        );

        assert.strictEqual(report.exitCode, 0);
        yield* parseSuccess(report.stdout);
        assert(!report.stdout.includes("private-cli"));
      }),
    { arbitrary: { runs: 12 } },
  );

  it.live("native byte input handles fragmented UTF-8 and releases consumed input", () =>
    Effect.gen(function* readNativeCliInput() {
      const bytes = Buffer.from(JSON.stringify({ message }));

      const stream = Readable.from(
        Array.from(bytes, (byte) => Buffer.from([byte])),
        { objectMode: false },
      );

      const report = yield* Effect.gen(function* validateNativeCliStream() {
        const cli = yield* EmailCli;

        return yield* cli.run(["validate"]);
      }).pipe(
        Effect.provide(
          emailCliLayer.pipe(
            Layer.provide(
              nodeEmailCliEnvironmentLayer(stream, new URL("../package.json", import.meta.url)),
            ),
          ),
        ),
      );

      assert.strictEqual(report.exitCode, 0);
      assert(stream.isPaused());
    }),
  );

  for (const [name, bytes, reason] of [
    ["malformed UTF-8", Buffer.from([0xc3, 0x28]), "invalid-utf8"],
    ["oversized input", Buffer.alloc(33_554_433, 32), "input-limit"],
  ] as const) {
    it.live(`native byte input refuses ${name}`, () =>
      Effect.gen(function* refuseNativeCliBytes() {
        const cli = yield* EmailCli;
        const report = yield* cli.run(["validate"]);
        assert.strictEqual(report.exitCode, 1);
        assert.strictEqual((yield* parseFailure(report.stderr)).reason, reason);
      }).pipe(
        Effect.provide(
          emailCliLayer.pipe(
            Layer.provide(
              nodeEmailCliEnvironmentLayer(
                Readable.from([bytes], { objectMode: false }),
                new URL("../package.json", import.meta.url),
              ),
            ),
          ),
        ),
      ),
    );
  }

  it.live("accepts a valid document at the exact native byte boundary", () =>
    Effect.gen(function* acceptCliByteBoundary() {
      const document = Buffer.from(JSON.stringify({ message }));

      const stream = Readable.from([Buffer.alloc(33_554_432 - document.byteLength, 32), document], {
        objectMode: false,
      });

      const report = yield* Effect.gen(function* validateCliBoundaryStream() {
        const cli = yield* EmailCli;

        return yield* cli.run(["validate"]);
      }).pipe(
        Effect.provide(
          emailCliLayer.pipe(
            Layer.provide(
              nodeEmailCliEnvironmentLayer(stream, new URL("../package.json", import.meta.url)),
            ),
          ),
        ),
      );

      assert.strictEqual(report.exitCode, 0);
      yield* parseSuccess(report.stdout);
    }),
  );

  it.live("maps native stream failure to a safe unavailable-input report", () =>
    Effect.gen(function* failNativeCliInput() {
      const input = new Readable({
        read() {
          this.destroy(new Error("private-cli-native-error"));
        },
      });

      const report = yield* Effect.gen(function* runFailingCliInput() {
        const cli = yield* EmailCli;

        return yield* cli.run(["validate"]);
      }).pipe(
        Effect.provide(
          emailCliLayer.pipe(
            Layer.provide(
              nodeEmailCliEnvironmentLayer(input, new URL("../package.json", import.meta.url)),
            ),
          ),
        ),
      );

      assert.strictEqual((yield* parseFailure(report.stderr)).reason, "input-unavailable");
      assert(!report.stderr.includes("private-cli"));
    }),
  );

  it.live("missing package metadata does not block help or validation", () =>
    Effect.gen(function* isolateCliMetadataRead() {
      const cli = yield* EmailCli;
      assert.strictEqual((yield* cli.run(["help"])).exitCode, 0);
      const missing = yield* cli.run(["discover"]);
      assert.strictEqual((yield* parseFailure(missing.stderr)).reason, "distribution-unavailable");
      assert(!missing.stderr.includes("private-cli"));
      assert.strictEqual((yield* cli.run(["validate"])).exitCode, 0);
    }).pipe(
      Effect.provide(
        emailCliLayer.pipe(
          Layer.provide(
            nodeEmailCliEnvironmentLayer(
              Readable.from([Buffer.from(JSON.stringify({ message }))], { objectMode: false }),
              new URL("../private-cli-nonexistent/package.json", import.meta.url),
            ),
          ),
        ),
      ),
    ),
  );

  it.live("interrupting native input stops consuming the caller-owned stream", () =>
    Effect.gen(function* interruptNativeCliInput() {
      const input = new PassThrough();
      const resumed = yield* Queue.unbounded<boolean>();
      input.once("resume", () => {
        Queue.offerUnsafe(resumed, true);
      });

      const fiber = yield* Effect.gen(function* readNativePendingInput() {
        const cli = yield* EmailCli;

        return yield* cli.run(["validate"]);
      }).pipe(
        Effect.provide(
          emailCliLayer.pipe(
            Layer.provide(
              nodeEmailCliEnvironmentLayer(input, new URL("../package.json", import.meta.url)),
            ),
          ),
        ),
        Effect.forkScoped,
      );

      yield* Queue.take(resumed);
      yield* Fiber.interrupt(fiber);
      assert(Exit.hasInterrupts(yield* Fiber.await(fiber)));
      assert(input.isPaused());
      input.end("private-cli-after-cancel");
      assert(input.readableLength > 0);
      input.destroy();
    }),
  );
});
