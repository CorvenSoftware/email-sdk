import { assert, describe, it } from "@effect/vitest";
import {
  Cause,
  DateTime,
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
import { startEmailTraceFixture } from "../test/email-tracing-fixture.js";
import { TestClock } from "effect/testing";
import { emailFixtureClientLayer, startEmailHttpFixture } from "../test/email-http-fixture.js";
import {
  Email,
  EmailConfigurationError,
  EmailDeliveryUnknown,
  EmailInvalidMessage,
  EmailInvalidOptions,
  EmailReceiptSchema,
  EmailRejected,
  emailAttachmentFromBytes,
  EmailRouter,
  emailRouterLayer,
} from "./index.js";
import { sendgridEmailLayer, sendgridPersonalizedEmailLayer } from "./sendgrid-email-sender.js";
import { recordingEmailLayer } from "./recording-email-sender.js";

const message = {
  body: { html: "<p>Fictional café</p>", text: "Fictional café" },
  from: "sender@example.test",
  subject: "Synthetic SendGrid notification",
  to: "recipient@example.test",
} as const;

const policy = {
  deadline: Duration.seconds(5),
  initialDelay: Duration.millis(100),
  maxAttempts: 1,
};

const mailbox = Schema.Struct({ email: Schema.String, name: Schema.optionalKey(Schema.String) });

const Payload = Schema.Struct({
  attachments: Schema.Array(
    Schema.Struct({
      content: Schema.String,
      content_id: Schema.optionalKey(Schema.String),
      disposition: Schema.String,
      filename: Schema.String,
      type: Schema.String,
    }),
  ),
  categories: Schema.Array(Schema.String),
  content: Schema.Array(Schema.Struct({ type: Schema.String, value: Schema.String })),
  from: mailbox,
  mail_settings: Schema.Struct({
    footer: Schema.Struct({ enable: Schema.Boolean }),
    sandbox_mode: Schema.Struct({ enable: Schema.Boolean }),
  }),
  personalizations: Schema.NonEmptyArray(
    Schema.Struct({
      bcc: Schema.Array(mailbox),
      cc: Schema.Array(mailbox),
      custom_args: Schema.Record(Schema.String, Schema.String),
      headers: Schema.Record(Schema.String, Schema.String),
      to: Schema.Array(mailbox),
    }),
  ),
  reply_to_list: Schema.Array(mailbox),
  send_at: Schema.Int,
  subject: Schema.String,
  tracking_settings: Schema.Struct({
    click_tracking: Schema.Struct({ enable: Schema.Boolean, enable_text: Schema.Boolean }),
    ganalytics: Schema.Struct({ enable: Schema.Boolean }),
    open_tracking: Schema.Struct({ enable: Schema.Boolean }),
    subscription_tracking: Schema.Struct({ enable: Schema.Boolean }),
  }),
});

describe("SendGrid local HTTP wire", () => {
  it.effect.each([
    { origin: "https://api.sendgrid.com", region: "Global" },
    { origin: "https://api.eu.sendgrid.com", region: "Europe" },
  ] as const)(
    "maps complete message intent to the $region endpoint without enabling tracking or sandbox",
    ({ origin, region }) =>
      Effect.gen(function* observeSendgridWire() {
        yield* TestClock.setTime(
          DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-13T12:00:00Z")),
        );

        const fixture = yield* startEmailHttpFixture({
          body: "",
          messageId: "provider.message-1",
          status: 202,
        });

        const receipt = yield* Effect.gen(function* sendWireNotification() {
          const attachment = yield* emailAttachmentFromBytes(new Uint8Array([0, 255, 128, 10]), {
            contentId: "logo",
            contentType: "application/octet-stream",
            filename: "sample.dat",
          });

          return yield* (yield* Email).send({
            ...message,
            attachments: [attachment],
            bcc: "hidden@example.test",
            cc: { address: "copy@example.test", name: "Fictional Copy" },
            from: { address: message.from, name: 'Fictional, "Team"' },
            headers: [{ name: "X-Workflow", value: "synthetic" }],
            metadata: { workflow: "fictional" },
            replyTo: [
              "reply@example.test",
              { address: "another-reply@example.test", name: "Another Reply" },
            ],
            sendAt: "2026-10-13T12:30:00Z",
            tags: [{ name: "workflow", value: "synthetic value" }],
            to: { address: message.to, name: "Fictional Café" },
          });
        }).pipe(
          Effect.provide(
            sendgridEmailLayer({ apiKey: Redacted.make("fictional-token"), region }, policy).pipe(
              Layer.provide(emailFixtureClientLayer(fixture.url, origin)),
            ),
          ),
        );

        const request = yield* Queue.take(fixture.received);
        const payload = yield* Schema.decodeEffect(Schema.fromJsonString(Payload))(request.body);
        assert.strictEqual(request.method, "POST");
        assert.strictEqual(request.path, "/v3/mail/send");
        assert.strictEqual(request.authorization, "Bearer fictional-token");
        assert.strictEqual(request.idempotencyKey, "");
        assert.deepStrictEqual(payload.from, { email: message.from, name: 'Fictional, "Team"' });
        const [personalization] = payload.personalizations;
        assert.deepStrictEqual(personalization.to, [{ email: message.to, name: "Fictional Café" }]);
        assert.deepStrictEqual(personalization.cc, [
          { email: "copy@example.test", name: "Fictional Copy" },
        ]);
        assert.deepStrictEqual(personalization.bcc, [{ email: "hidden@example.test" }]);
        assert.deepStrictEqual(payload.reply_to_list, [
          { email: "reply@example.test" },
          { email: "another-reply@example.test", name: "Another Reply" },
        ]);
        assert.deepStrictEqual(payload.content, [
          { type: "text/plain", value: message.body.text },
          { type: "text/html", value: message.body.html },
        ]);
        assert.strictEqual(payload.subject, message.subject);
        assert.strictEqual(personalization.headers["X-Workflow"], "synthetic");
        assert.strictEqual(personalization.custom_args.workflow, "fictional");
        assert.deepStrictEqual(payload.categories, ["workflow:synthetic value"]);
        assert.strictEqual(payload.send_at, 1_791_894_600);
        const [file] = payload.attachments;
        assert(file !== undefined);
        assert.deepStrictEqual([...Buffer.from(file.content, "base64")], [0, 255, 128, 10]);
        assert.strictEqual(file.filename, "sample.dat");
        assert.strictEqual(file.type, "application/octet-stream");
        assert.strictEqual(file.content_id, "logo");
        assert.strictEqual(file.disposition, "inline");
        assert.strictEqual(payload.mail_settings.sandbox_mode.enable, false);
        assert.strictEqual(payload.tracking_settings.click_tracking.enable, false);
        assert.strictEqual(payload.tracking_settings.click_tracking.enable_text, false);
        assert.strictEqual(payload.tracking_settings.open_tracking.enable, false);
        assert.strictEqual(payload.tracking_settings.ganalytics.enable, false);
        assert.strictEqual(payload.tracking_settings.subscription_tracking.enable, false);
        assert.strictEqual(payload.mail_settings.footer.enable, false);
        assert(EmailReceiptSchema.guards.Accepted(receipt));
        assert.strictEqual(receipt.provider, "sendgrid");
        assert.strictEqual(receipt.messageId, "provider.message-1");
      }),
  );

  it.live.each([
    { body: "", label: "empty body without a message identifier" },
    { body: "private-non-json-body", label: "non-JSON body without a message identifier" },
    {
      body: "private-".repeat(128 * 1024),
      label: "oversized irrelevant body",
      messageId: "provider-id",
    },
    { body: "", label: "unusable identifier", messageId: "private identifier with spaces" },
  ])(
    "preserves documented 202 acceptance with $label instead of inventing an ID or permitting fallback",
    (reply) =>
      Effect.gen(function* acceptDocumentedStatus() {
        const fixture = yield* startEmailHttpFixture({ ...reply, status: 202 });

        const receipt = yield* Effect.gen(function* submitAcknowledgedNotification() {
          const selected = yield* (yield* EmailRouter).select();

          return yield* selected.send(message);
        }).pipe(
          Effect.provide(
            emailRouterLayer(
              [
                {
                  layer: sendgridEmailLayer(
                    { apiKey: Redacted.make("fictional-token") },
                    policy,
                  ).pipe(
                    Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.sendgrid.com")),
                  ),
                  name: "primary",
                },
                { layer: recordingEmailLayer, name: "secondary" },
              ],
              { fallbacks: ["secondary"], primary: "primary" },
            ),
          ),
        );

        assert(EmailReceiptSchema.guards.Accepted(receipt));
        assert.strictEqual(receipt.provider, "sendgrid");
        assert.strictEqual(
          receipt.messageId,
          reply.messageId === "provider-id" ? "provider-id" : undefined,
        );
        assert.strictEqual(receipt.route, "primary");
        assert.notInclude(JSON.stringify(receipt), "private");
        assert.strictEqual(yield* Queue.size(fixture.received), 1);
      }),
  );

  it.live.each([
    { reason: "unexpected-status", status: 200, unknown: true },
    { reason: "unexpected-status", status: 204, unknown: true },
    { reason: "invalid-message", status: 400, unknown: false },
    { reason: "authentication", status: 401, unknown: false },
    { reason: "authentication", status: 403, unknown: false },
    { reason: "invalid-message", status: 413, unknown: false },
    { reason: "rate-limited", status: 429, unknown: false },
    { reason: "unexpected-status", status: 408, unknown: true },
    { reason: "server-error", status: 503, unknown: true },
  ])(
    "classifies $status/$reason without trusting an error-body ID or leaking details",
    (scenario) =>
      Effect.gen(function* classifySendgridStatus() {
        const fixture = yield* startEmailHttpFixture({
          body: '{"errors":[{"message":"private recipient details"}],"id":"misleading-id"}',
          messageId: "misleading-header-id",
          retryAfter: "12",
          status: scenario.status,
        });

        const failure = yield* Effect.gen(function* submitStatusNotification() {
          return yield* (yield* Email).send(message);
        }).pipe(
          Effect.provide(
            sendgridEmailLayer({ apiKey: Redacted.make("fictional-token") }, policy).pipe(
              Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.sendgrid.com")),
            ),
          ),
          Effect.flip,
        );

        assert(Schema.is(EmailDeliveryUnknown)(failure) || Schema.is(EmailRejected)(failure));
        assert.strictEqual(Schema.is(EmailDeliveryUnknown)(failure), scenario.unknown);
        assert.strictEqual(failure.reason, scenario.reason);
        assert.strictEqual(failure.status, scenario.status);

        if (Schema.is(EmailRejected)(failure) && scenario.status === 429) {
          assert.strictEqual(failure.retryAfterMillis, 12_000);
        }

        assert.notInclude(JSON.stringify(failure), "private");
        assert.notInclude(JSON.stringify(failure), "misleading");
        assert.strictEqual(yield* Queue.size(fixture.received), 1);
      }),
  );

  it.live("rejects keys and invalid credential configuration locally before HTTP", () =>
    Effect.gen(function* rejectUnownedSendgridAuthority() {
      const fixture = yield* startEmailHttpFixture({ body: "", status: 202 });
      const client = emailFixtureClientLayer(fixture.url, "https://api.sendgrid.com");

      const configuration = yield* Effect.service(Email).pipe(
        Effect.provide(
          sendgridEmailLayer({ apiKey: Redacted.make("private token") }).pipe(
            Layer.provide(client),
          ),
        ),
        Effect.flip,
      );

      assert(Schema.is(EmailConfigurationError)(configuration));
      assert.strictEqual(configuration.issues[0]?.path, "apiKey");
      assert.notInclude(JSON.stringify(configuration), "private");

      const key = yield* Effect.gen(function* submitWithUnsupportedKey() {
        return yield* (yield* Email).send(message, { idempotencyKey: "private-key" });
      }).pipe(
        Effect.provide(
          sendgridEmailLayer({ apiKey: Redacted.make("fictional-token") }).pipe(
            Layer.provide(client),
          ),
        ),
        Effect.flip,
      );

      assert(Schema.is(EmailRejected)(key));
      assert.strictEqual(key.reason, "unsupported-idempotency");
      assert.strictEqual(yield* Queue.size(fixture.received), 0);
    }),
  );
});

const NativePayload = Schema.Struct({
  attachments: Schema.optionalKey(Payload.fields.attachments),
  categories: Schema.optionalKey(Payload.fields.categories),
  content: Payload.fields.content,
  mail_settings: Payload.fields.mail_settings,
  personalizations: Schema.NonEmptyArray(
    Schema.Struct({
      bcc: Schema.optionalKey(Schema.Array(mailbox)),
      cc: Schema.optionalKey(Schema.Array(mailbox)),
      custom_args: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
      headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
      subject: Schema.String,
      substitutions: Schema.Record(Schema.String, Schema.String),
      to: Schema.NonEmptyArray(mailbox),
    }),
  ),
  reply_to_list: Schema.optionalKey(Payload.fields.reply_to_list),
  send_at: Schema.optionalKey(Schema.Int),
  tracking_settings: Payload.fields.tracking_settings,
});

const nativeTemplate = {
  body: {
    html: "<p>%recipient.name% / %recipient.active%</p>",
    text: "%recipient.name% / %recipient.active%",
  },
  from: "sender@example.test",
  subject: "Hello %recipient.name%",
} as const;

const nativeRecipients = [
  { to: "first@example.test", variables: { active: false, name: "A<&\"'" } },
  {
    to: { address: "second@example.test", name: "Second" },
    variables: { active: true, name: "B" },
  },
] as const;

const readNativePayload = Schema.decodeEffect(Schema.fromJsonString(NativePayload));

const substituteNativeContent = (
  content: string,
  substitutions: Readonly<Record<string, string>>,
) => {
  let value = content;

  for (const [token, replacement] of Object.entries(substitutions)) {
    value = value.replaceAll(token, replacement);
  }

  return value;
};

describe("SendGrid native personalization", () => {
  it.effect.each([
    { origin: "https://api.sendgrid.com", region: "Global" },
    { origin: "https://api.eu.sendgrid.com", region: "Europe" },
  ] as const)(
    "sends isolated rich recipient envelopes in one $region request with exact text and HTML",
    ({ origin, region }) =>
      Effect.gen(function* sendNativeRichAudience() {
        yield* TestClock.setTime(0);

        const fixture = yield* startEmailHttpFixture({
          body: "private-unused-response",
          messageId: "batch-not-recipient-id",
          status: 202,
        });

        const trace = yield* startEmailTraceFixture();

        const outcomes = yield* Effect.gen(function* submitRichNativeAudience() {
          const attachment = yield* emailAttachmentFromBytes(new Uint8Array([0, 255]), {
            contentId: "logo",
            contentType: "image/png",
            filename: "logo.png",
          });

          const email = yield* Email;
          yield* email.validate({ ...message, sendAt: new Date(60_000) });
          assert.strictEqual(yield* Queue.size(fixture.received), 0);

          return yield* email.sendPersonalized(
            {
              message: {
                ...nativeTemplate,
                attachments: [attachment],
                headers: [{ name: "X-Workflow", value: "native" }],
                metadata: { privateKey: "private-metadata" },
                replyTo: "reply@example.test",
                sendAt: new Date(60_000),
                tags: [{ name: "channel", value: "native" }],
              },
              recipients: nativeRecipients,
            },
            {
              executionMetadata: {
                nested: {
                  at: DateTime.makeUnsafe("2026-01-02T03:04:05.123Z"),
                  detail: "private-personalized-nested-context",
                },
                tenant: "private-personalized-context",
              },
            },
          );
        }).pipe(
          Effect.provide(
            sendgridPersonalizedEmailLayer(
              { apiKey: Redacted.make("private-fictional-key"), region },
              policy,
            ).pipe(Layer.provide(emailFixtureClientLayer(fixture.url, origin))),
          ),
          Effect.withTracer(trace.tracer),
        );

        assert.strictEqual(outcomes.length, 2);

        for (const result of outcomes) {
          assert(Result.isSuccess(result));
          assert(EmailReceiptSchema.guards.Accepted(result.success));
          assert.strictEqual(result.success.provider, "sendgrid");
          assert.notProperty(result.success, "messageId");
          assert.strictEqual(result.success.submissionId, "batch-not-recipient-id");
          assert(Object.isFrozen(result.success));
        }

        const request = yield* Queue.take(fixture.received);
        const payload = yield* readNativePayload(request.body);
        assert.notInclude(request.body, "private-personalized-context");
        assert.notInclude(request.body, "private-personalized-nested-context");
        assert.notInclude(request.body, "executionMetadata");
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
        assert.strictEqual(request.path, "/v3/mail/send");
        assert.strictEqual(request.authorization, "Bearer private-fictional-key");
        assert.strictEqual(request.idempotencyKey, "");
        assert.strictEqual(payload.personalizations.length, 2);
        const [first, second] = payload.personalizations;
        assert.isDefined(second);
        assert.deepStrictEqual(first.to, [{ email: "first@example.test" }]);
        assert.deepStrictEqual(second.to, [{ email: "second@example.test", name: "Second" }]);
        assert.strictEqual(first.subject, "Hello A<&\"'");
        assert.strictEqual(second.subject, "Hello B");

        for (const entry of payload.personalizations) {
          assert.deepStrictEqual(entry.headers, { "X-Workflow": "native" });
          assert.deepStrictEqual(entry.custom_args, { privateKey: "private-metadata" });
          assert.notProperty(entry, "cc");
          assert.notProperty(entry, "bcc");
        }

        const [text, html] = payload.content;
        assert.isDefined(text);
        assert.isDefined(html);
        assert.strictEqual(
          substituteNativeContent(text.value, first.substitutions),
          "A<&\"' / false",
        );
        assert.strictEqual(
          substituteNativeContent(html.value, first.substitutions),
          "<p>A&lt;&amp;&quot;&#39; / false</p>",
        );
        assert.strictEqual(
          substituteNativeContent(html.value, second.substitutions),
          "<p>B / true</p>",
        );
        assert.deepStrictEqual(payload.categories, ["channel:native"]);
        assert.deepStrictEqual(payload.reply_to_list, [{ email: "reply@example.test" }]);
        assert.strictEqual(payload.send_at, 60);
        assert.deepStrictEqual(payload.attachments?.[0], {
          content: "AP8=",
          content_id: "logo",
          disposition: "inline",
          filename: "logo.png",
          type: "image/png",
        });
        assert.strictEqual(payload.mail_settings.sandbox_mode.enable, false);
        assert.strictEqual(payload.tracking_settings.click_tracking.enable, false);
        assert.strictEqual(payload.tracking_settings.open_tracking.enable, false);
        assert.strictEqual(payload.tracking_settings.ganalytics.enable, false);
        assert.strictEqual(payload.tracking_settings.subscription_tracking.enable, false);
        assert.strictEqual(payload.mail_settings.footer.enable, false);

        const diagnostics = yield* trace.diagnostics;

        for (const privateValue of [
          "private-fictional-key",
          "private-metadata",
          "private-unused-response",
          "first@example.test",
          "batch-not-recipient-id",
          "A<&",
        ]) {
          assert.notInclude(diagnostics, privateValue);
        }
      }),
  );

  it.effect(
    "settles local missing variables, oversized bodies and unsupported keys while sending only valid envelopes",
    () =>
      Effect.gen(function* isolateNativeLocalFailures() {
        const fixture = yield* startEmailHttpFixture({ body: "", status: 202 });

        const outcomes = yield* Effect.gen(function* sendMixedNativeAudience() {
          return yield* (yield* Email).sendPersonalized({
            message: { ...nativeTemplate, subject: "Native local boundaries" },
            recipients: [
              nativeRecipients[0],
              { to: "missing@example.test", variables: { active: true } },
              { ...nativeRecipients[1], idempotencyKey: "not-native-authority" },
              { to: "large@example.test", variables: { active: true, name: "x".repeat(5000) } },
              { to: "last@example.test", variables: { active: true, name: "Last" } },
            ],
          });
        }).pipe(
          Effect.provide(
            sendgridPersonalizedEmailLayer(
              { apiKey: Redacted.make("fictional-token") },
              policy,
            ).pipe(Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.sendgrid.com"))),
          ),
        );

        assert.deepStrictEqual(
          outcomes.map((result) =>
            Result.match(result, {
              onFailure: (failure) => failure._tag,
              onSuccess: (receipt) => receipt._tag,
            }),
          ),
          ["Accepted", "EmailInvalidMessage", "EmailRejected", "EmailInvalidMessage", "Accepted"],
        );
        const payload = yield* readNativePayload((yield* Queue.take(fixture.received)).body);
        assert.deepStrictEqual(
          payload.personalizations.map((entry) => entry.to[0].email),
          ["first@example.test", "last@example.test"],
        );
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );

  it.effect.each([
    { accepted: true, label: "exact ASCII byte boundary", value: "x".repeat(8181) },
    { accepted: false, label: "over ASCII byte boundary", value: "x".repeat(8182) },
    { accepted: true, label: "exact multibyte boundary", value: `${"é".repeat(4090)}x` },
    { accepted: false, label: "over multibyte boundary", value: `${"é".repeat(4090)}xx` },
  ])("enforces the native body JSON budget at $label", ({ accepted, value }) =>
    Effect.gen(function* boundNativeBodyBytes() {
      const fixture = yield* startEmailHttpFixture({ body: "", status: 202 });

      const outcomes = yield* Effect.gen(function* sendBoundedNativeBody() {
        return yield* (yield* Email).sendPersonalized({
          message: {
            ...nativeTemplate,
            body: { text: "%recipient.content%" },
            subject: "Native budget",
          },
          recipients: [{ to: "recipient@example.test", variables: { content: value } }],
        });
      }).pipe(
        Effect.provide(
          sendgridPersonalizedEmailLayer({ apiKey: Redacted.make("fictional-token") }, policy).pipe(
            Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.sendgrid.com")),
          ),
        ),
      );

      const [result] = outcomes;
      assert.isDefined(result);
      assert.strictEqual(Result.isSuccess(result), accepted);
      assert.strictEqual(yield* Queue.size(fixture.received), accepted ? 1 : 0);

      if (Result.isFailure(result)) {
        assert(result.failure instanceof EmailInvalidMessage);
        assert.strictEqual(result.failure.issues[0]?.path, "body");
        assert.notInclude(JSON.stringify(result.failure), value);
      }
    }),
  );

  it.effect.each([200, 308, 400, 401, 429, 503])(
    "preserves shared %s evidence without reading private bodies or inventing recipient identities",
    (status) =>
      Effect.gen(function* classifyNativeAcknowledgement() {
        const fixture = yield* startEmailHttpFixture({ body: "private-response", status });

        const outcomes = yield* Effect.gen(function* sendNativeStatus() {
          return yield* (yield* Email).sendPersonalized({
            message: nativeTemplate,
            recipients: nativeRecipients,
          });
        }).pipe(
          Effect.provide(
            sendgridPersonalizedEmailLayer(
              { apiKey: Redacted.make("fictional-token") },
              policy,
            ).pipe(Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.sendgrid.com"))),
          ),
        );

        assert.strictEqual(outcomes.length, 2);

        for (const result of outcomes) {
          assert(Result.isFailure(result));
          assert.strictEqual(
            result.failure._tag,
            [400, 401, 429].includes(status) ? "EmailRejected" : "EmailDeliveryUnknown",
          );
          assert.notInclude(JSON.stringify(result.failure), "private-response");
        }

        assert.strictEqual(yield* Queue.size(fixture.received), 1);
      }),
  );

  it.effect.each([
    { label: "missing" },
    { label: "unusable", messageId: "private invalid handle" },
  ])("does not synthesize native submission correlation from a $label header", (reply) =>
    Effect.gen(function* preserveOptionalNativeCorrelation() {
      const fixture = yield* startEmailHttpFixture({ ...reply, body: "", status: 202 });

      const outcomes = yield* Effect.gen(function* submitUncorrelatedNativeAudience() {
        return yield* (yield* Email).sendPersonalized({
          message: nativeTemplate,
          recipients: nativeRecipients,
        });
      }).pipe(
        Effect.provide(
          sendgridPersonalizedEmailLayer({ apiKey: Redacted.make("fictional-token") }, policy).pipe(
            Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.sendgrid.com")),
          ),
        ),
      );

      assert.strictEqual(outcomes.length, 2);

      for (const outcome of outcomes) {
        assert(Result.isSuccess(outcome));
        assert(EmailReceiptSchema.guards.Accepted(outcome.success));
        assert.notProperty(outcome.success, "messageId");
        assert.notProperty(outcome.success, "submissionId");
      }

      assert.strictEqual(yield* Queue.size(fixture.received), 1);
    }),
  );

  it.effect("never replays a shared unknown even with several configured attempts", () =>
    Effect.gen(function* refuseNativeUncertainReplay() {
      const fixture = yield* startEmailHttpFixture({
        body: "",
        next: { body: "", status: 202 },
        status: 503,
      });

      const outcomes = yield* Effect.gen(function* sendUncertainNativeAudience() {
        return yield* (yield* Email).sendPersonalized({
          message: nativeTemplate,
          recipients: nativeRecipients,
        });
      }).pipe(
        Effect.provide(
          sendgridPersonalizedEmailLayer(
            { apiKey: Redacted.make("fictional-token") },
            { ...policy, maxAttempts: 3 },
          ).pipe(Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.sendgrid.com"))),
        ),
      );

      assert(
        outcomes.every(
          (result) => Result.isFailure(result) && result.failure instanceof EmailDeliveryUnknown,
        ),
      );
      assert.strictEqual(yield* Queue.size(fixture.received), 1);
    }),
  );

  it.effect.each([false, true])(
    "owns the complete native request across backoff and rechecks scheduling expiry=$0",
    (expires) =>
      Effect.gen(function* ownRetriedNativeIntent() {
        yield* TestClock.setTime(0);
        const ready = yield* Deferred.make<boolean>();
        const release = yield* Deferred.make<boolean>();

        const fixture = yield* startEmailHttpFixture({
          body: "",
          next: { body: "", status: 202 },
          status: 429,
        });

        const recipient = {
          to: "recipient@example.test",
          variables: { active: false, name: "Before" },
        };

        const input = {
          message: {
            ...nativeTemplate,
            body: { html: nativeTemplate.body.html, text: "Original text" },
            sendAt: new Date(expires ? 1000 : 60_000),
          },
          recipients: [recipient] as const,
        };

        const fiber = yield* Effect.gen(function* sendRetriedNativeAudience() {
          return yield* (yield* Email).sendPersonalized(input);
        }).pipe(
          Effect.provide(
            sendgridPersonalizedEmailLayer(
              { apiKey: Redacted.make("fictional-token") },
              { ...policy, maxAttempts: 2 },
              () => Deferred.succeed(ready, true).pipe(Effect.andThen(Deferred.await(release))),
            ).pipe(Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.sendgrid.com"))),
          ),
          Effect.forkScoped,
        );

        yield* Deferred.await(ready);
        recipient.variables.name = "After";
        input.message.body.text = "Changed";
        input.message.sendAt.setTime(120_000);
        yield* TestClock.adjust(2000);
        yield* Deferred.succeed(release, true);
        yield* TestClock.adjust(1000);
        const outcomes = yield* Fiber.join(fiber);
        const first = yield* Queue.take(fixture.received);

        if (expires) {
          assert(
            outcomes.every(
              (result) =>
                Result.isFailure(result) &&
                result.failure instanceof EmailRejected &&
                result.failure.reason === "invalid-message",
            ),
          );
          assert.strictEqual(yield* Queue.size(fixture.received), 0);
        } else {
          assert(outcomes.every(Result.isSuccess));
          const second = yield* Queue.take(fixture.received);
          assert.strictEqual(second.body, first.body);
          const payload = yield* readNativePayload(second.body);
          assert.strictEqual(payload.personalizations[0].subject, "Hello Before");
          assert.strictEqual(payload.send_at, 60);
        }
      }),
  );

  it.effect("cancels the single active request and waits for socket cleanup", () =>
    Effect.gen(function* cancelNativeAudience() {
      const fixture = yield* startEmailHttpFixture({ body: "", hold: true, status: 202 });

      const fiber = yield* Effect.gen(function* sendHeldNativeAudience() {
        return yield* (yield* Email).sendPersonalized({
          message: nativeTemplate,
          recipients: nativeRecipients,
        });
      }).pipe(
        Effect.provide(
          sendgridPersonalizedEmailLayer({ apiKey: Redacted.make("fictional-token") }).pipe(
            Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.sendgrid.com")),
          ),
        ),
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

  it.effect(
    "refuses invalid batch options, duplicate audiences and exhausted token candidates without HTTP",
    () =>
      Effect.gen(function* refuseInvalidNativeBoundaries() {
        const fixture = yield* startEmailHttpFixture({ body: "", status: 202 });
        yield* Effect.gen(function* exerciseNativeLocalBoundaries() {
          const email = yield* Email;

          const invalidOptions = yield* email
            .sendPersonalized(
              { message: nativeTemplate, recipients: nativeRecipients },
              { concurrency: 0 },
            )
            .pipe(Effect.flip);

          assert(invalidOptions instanceof EmailInvalidOptions);

          const duplicate = yield* email
            .sendPersonalized({
              message: nativeTemplate,
              recipients: [nativeRecipients[0], nativeRecipients[0]],
            })
            .pipe(Effect.flip);

          assert(duplicate instanceof EmailInvalidMessage);

          const collision = yield* email.sendPersonalized({
            message: {
              ...nativeTemplate,
              body: { text: Array.from({ length: 64 }, (_, i) => `-corven-${i}-`).join("") },
            },
            recipients: nativeRecipients,
          });

          assert(
            collision.every(
              (item) => Result.isFailure(item) && item.failure instanceof EmailInvalidMessage,
            ),
          );
        }).pipe(
          Effect.provide(
            sendgridPersonalizedEmailLayer({ apiKey: Redacted.make("fictional-token") }).pipe(
              Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.sendgrid.com")),
            ),
          ),
        );
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );

  it.effect(
    "accepts the complete 500-recipient audience without splitting visibility or manufacturing identities",
    () =>
      Effect.gen(function* submitLargestNativeAudience() {
        const fixture = yield* startEmailHttpFixture({ body: "", status: 202 });

        const recipients = [
          { to: "first@example.test", variables: { active: false, name: "First" } },
          ...Array.from({ length: 499 }, (_, index) => ({
            to: `r${index}@example.test`,
            variables: { active: true, name: String(index) },
          })),
        ] as const;

        yield* Effect.gen(function* sendCompleteNativeAudience() {
          const email = yield* Email;
          const outcomes = yield* email.sendPersonalized({ message: nativeTemplate, recipients });
          assert.strictEqual(outcomes.length, 500);
          assert(outcomes.every(Result.isSuccess));

          const over = yield* email
            .sendPersonalized({
              message: nativeTemplate,
              recipients: [
                ...recipients,
                { to: "overflow@example.test", variables: { active: false, name: "Overflow" } },
              ],
            })
            .pipe(Effect.flip);

          assert(over instanceof EmailInvalidMessage);

          const headers = [
            { name: "X-First", value: "h".repeat(998) },
            ...Array.from({ length: 63 }, (_, index) => ({
              name: `X-Long-${index}`,
              value: "h".repeat(998),
            })),
          ] as const;

          const oversized = yield* email.sendPersonalized({
            message: { ...nativeTemplate, headers },
            recipients,
          });

          assert(
            oversized.every(
              (item) => Result.isFailure(item) && item.failure instanceof EmailInvalidMessage,
            ),
          );
        }).pipe(
          Effect.provide(
            sendgridPersonalizedEmailLayer(
              { apiKey: Redacted.make("fictional-token") },
              policy,
            ).pipe(Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.sendgrid.com"))),
          ),
        );
        const payload = yield* readNativePayload((yield* Queue.take(fixture.received)).body);
        assert.deepStrictEqual(
          payload.personalizations.map((entry) => entry.to.map((address) => address.email)),
          recipients.map((recipient) => [recipient.to]),
        );
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );

  it.effect(
    "keeps retry callback defects outside ordinary settlement and private diagnostics",
    () =>
      Effect.gen(function* preserveNativeCallbackDefect() {
        const fixture = yield* startEmailHttpFixture({ body: "", status: 429 });
        const trace = yield* startEmailTraceFixture();

        const exit = yield* Effect.gen(function* failNativeRetryCallback() {
          return yield* (yield* Email).sendPersonalized({
            message: nativeTemplate,
            recipients: nativeRecipients,
          });
        }).pipe(
          Effect.provide(
            sendgridPersonalizedEmailLayer(
              { apiKey: Redacted.make("fictional-token") },
              { ...policy, maxAttempts: 2 },
              () => Effect.die("private-native-defect"),
            ).pipe(Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.sendgrid.com"))),
          ),
          Effect.withTracer(trace.tracer),
          Effect.exit,
        );

        assert(Exit.isFailure(exit));
        assert(Cause.hasDies(exit.cause));
        assert(!Cause.hasFails(exit.cause));
        assert(
          exit.cause.reasons.some(
            (reason) => Cause.isDieReason(reason) && reason.defect === "private-native-defect",
          ),
        );
        assert.strictEqual(yield* Queue.size(fixture.received), 1);
        assert.notInclude(yield* trace.diagnostics, "private-native-defect");
      }),
  );

  it.effect(
    "applies one native deadline to the active audience and awaits physical request cleanup",
    () =>
      Effect.gen(function* timeOutNativeAudience() {
        const fixture = yield* startEmailHttpFixture({ body: "", hold: true, status: 202 });

        const fiber = yield* Effect.gen(function* sendDeadlineNativeAudience() {
          return yield* (yield* Email).sendPersonalized({
            message: nativeTemplate,
            recipients: nativeRecipients,
          });
        }).pipe(
          Effect.provide(
            sendgridPersonalizedEmailLayer(
              { apiKey: Redacted.make("fictional-token") },
              policy,
            ).pipe(Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.sendgrid.com"))),
          ),
          Effect.forkScoped,
        );

        yield* Queue.take(fixture.received);
        yield* TestClock.adjust(Duration.seconds(5));
        const outcomes = yield* Fiber.join(fiber);
        assert(
          outcomes.every(
            (item) =>
              Result.isFailure(item) &&
              item.failure instanceof EmailDeliveryUnknown &&
              item.failure.reason === "timeout",
          ),
        );
        assert.strictEqual(yield* Queue.take(fixture.closed), true);
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );

  it.effect.prop(
    "preserves generated literal markers and escaped Unicode through native substitution",
    {
      characters: Schema.NonEmptyArray(
        Schema.Literals(["A", "é", "😀", "<", ">", "&", "'", '"', "\\"]),
      ).check(Schema.isMaxLength(16)),
    },
    ({ characters }) =>
      Effect.gen(function* preserveGeneratedNativeContent() {
        const fixture = yield* startEmailHttpFixture({ body: "", status: 202 });
        const name = `-corven-0-${characters.join("")}`;

        const outcomes = yield* Effect.gen(function* sendGeneratedNativeAudience() {
          return yield* (yield* Email).sendPersonalized({
            message: nativeTemplate,
            recipients: [{ to: "recipient@example.test", variables: { active: false, name } }],
          });
        }).pipe(
          Effect.provide(
            sendgridPersonalizedEmailLayer(
              { apiKey: Redacted.make("fictional-token") },
              policy,
            ).pipe(Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.sendgrid.com"))),
          ),
        );

        assert(outcomes.every(Result.isSuccess));
        const payload = yield* readNativePayload((yield* Queue.take(fixture.received)).body);
        const text = payload.content.find((part) => part.type === "text/plain");
        assert.isDefined(text);
        assert.strictEqual(
          substituteNativeContent(text.value, payload.personalizations[0].substitutions),
          `${name} / false`,
        );
      }),
    { arbitrary: { runs: 24 } },
  );
});
