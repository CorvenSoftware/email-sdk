import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Layer, Queue, Redacted, Result, Schema } from "effect";
import { emailFixtureClientLayer, startEmailHttpFixture } from "../test/email-http-fixture.js";
import type { EmailHttpFixture } from "../test/email-http-fixture.js";
import {
  Email,
  EmailConfigurationError,
  EmailDeliveryUnknown,
  EmailIdempotencyKeySchema,
  EmailInvalidMessage,
  EmailReceiptSchema,
  EmailRejected,
  EmailRouter,
  EmailSender,
  emailRouterLayer,
  parseEmailMessage,
} from "./index.js";
import { zeptomailEmailLayer, zeptomailSenderLayer } from "./zeptomail-email-sender.js";
import type { ZeptomailEmailOptions } from "./zeptomail-email-sender.js";
import { resendEmailLayer } from "./resend-email-sender.js";

const message = {
  body: { html: "<p>Synthetic café {{literal}}</p>", text: "Synthetic café {{literal}}" },
  from: { address: "sender@example.test", name: 'Fictional "Café"' },
  subject: "Synthetic ZeptoMail notification",
  to: ["recipient@example.test"],
} as const;

const options = { agentMode: "Live", apiKey: Redacted.make("fictional-zeptomail-key") } as const;

const policy = {
  deadline: Duration.seconds(5),
  initialDelay: Duration.millis(100),
  maxAttempts: 3,
};

const acknowledgement = {
  data: [{ additional_info: [], code: "EM_104", message: "Email request received" }],
  message: "OK",
  object: "email",
  request_id: "synthetic-request-id",
};

const fixtureZeptomailLayer = (fixture: EmailHttpFixture, agentMode: "Live" | "Sandbox" = "Live") =>
  zeptomailEmailLayer({ ...options, agentMode }, policy).pipe(
    Layer.provide(emailFixtureClientLayer(fixture.url, "https://cpaas.zoho.com")),
  );

const fixtureZeptomailRoute = (
  primary: EmailHttpFixture,
  backup: EmailHttpFixture,
  agentMode: "Live" | "Sandbox" = "Live",
) =>
  emailRouterLayer(
    [
      { layer: fixtureZeptomailLayer(primary, agentMode), name: "primary" },
      {
        layer: resendEmailLayer({ apiKey: Redacted.make("fictional-backup-key") }, policy).pipe(
          Layer.provide(emailFixtureClientLayer(backup.url, "https://api.resend.com")),
        ),
        name: "backup",
      },
    ],
    { fallbacks: ["backup"], primary: "primary" },
  );

const ZeptomailWireMailbox = Schema.Struct({
  address: Schema.String,
  name: Schema.optionalKey(Schema.String),
});

const ZeptomailWireRecipient = Schema.Struct({ email_address: ZeptomailWireMailbox });

const ZeptomailWire = Schema.Struct({
  attachments: Schema.Array(
    Schema.Struct({ content: Schema.String, mime_type: Schema.String, name: Schema.String }),
  ),
  bcc: Schema.Array(ZeptomailWireRecipient),
  cc: Schema.Array(ZeptomailWireRecipient),
  from: ZeptomailWireMailbox,
  htmlbody: Schema.String,
  inline_images: Schema.Array(
    Schema.Struct({
      cid: Schema.String,
      content: Schema.String,
      mime_type: Schema.String,
      name: Schema.String,
    }),
  ),
  mime_headers: Schema.Record(Schema.String, Schema.String),
  reply_to: Schema.Array(ZeptomailWireMailbox),
  subject: Schema.String,
  textbody: Schema.String,
  to: Schema.Array(ZeptomailWireRecipient),
  track_clicks: Schema.Boolean,
  track_opens: Schema.Boolean,
});

describe("ZeptoMail current CPaaS constrained single-send protocol", () => {
  it.live(
    "preserves structured group fields, reply lists, literal alternatives, MIME and independent inline bytes without tracking",
    () =>
      Effect.gen(function* inspectZeptomailWire() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 200,
        });

        const receipt = yield* Effect.gen(function* submitRichZeptomailMessage() {
          return yield* (yield* Email).send({
            ...message,
            attachments: [
              { contentBase64: "AP+ACg==", contentType: "application/pdf", filename: "sample.pdf" },
              {
                contentBase64: "AQID",
                contentId: "logo",
                contentType: "image/png",
                filename: "image.png",
              },
            ],
            bcc: { address: "hidden@example.test", name: "Hidden Fictional" },
            cc: "copy@example.test",
            headers: [{ name: "X-Workflow", value: "synthetic" }],
            replyTo: [
              { address: "reply@example.test", name: 'Reply "Café"' },
              "other@example.test",
            ],
            to: [{ address: "first@example.test", name: "First Fictional" }, "second@example.test"],
          });
        }).pipe(Effect.provide(fixtureZeptomailLayer(fixture)));

        assert(EmailReceiptSchema.guards.Accepted(receipt));
        assert.strictEqual(receipt.messageId, "synthetic-request-id");
        const sent = yield* Queue.take(fixture.received);
        assert.strictEqual(sent.method, "POST");
        assert.strictEqual(sent.path, "/v1.1/email");
        assert.strictEqual(sent.authorization, "Zoho-enczapikey fictional-zeptomail-key");
        assert.strictEqual(sent.idempotencyKey, "");
        const wire = yield* Schema.decodeEffect(Schema.fromJsonString(ZeptomailWire))(sent.body);
        assert.deepStrictEqual(wire.from, message.from);
        assert.deepStrictEqual(
          wire.to.map(({ email_address }) => email_address),
          [
            { address: "first@example.test", name: "First Fictional" },
            { address: "second@example.test" },
          ],
        );
        assert.deepStrictEqual(
          wire.cc.map(({ email_address }) => email_address),
          [{ address: "copy@example.test" }],
        );
        assert.deepStrictEqual(
          wire.bcc.map(({ email_address }) => email_address),
          [{ address: "hidden@example.test", name: "Hidden Fictional" }],
        );
        assert.deepStrictEqual(wire.reply_to, [
          { address: "reply@example.test", name: 'Reply "Café"' },
          { address: "other@example.test" },
        ]);
        assert.strictEqual(wire.mime_headers["X-Workflow"], "synthetic");
        assert.strictEqual(wire.subject, message.subject);
        assert.strictEqual(wire.textbody, message.body.text);
        assert.strictEqual(wire.htmlbody, message.body.html);
        assert.isFalse(wire.track_clicks);
        assert.isFalse(wire.track_opens);
        const [attachment] = wire.attachments;
        const [inline] = wire.inline_images;
        assert.isDefined(attachment);
        assert.isDefined(inline);
        assert.strictEqual(attachment.name, "sample.pdf");
        assert.strictEqual(attachment.mime_type, "application/pdf");
        assert.deepStrictEqual([...Buffer.from(attachment.content, "base64")], [0, 255, 128, 10]);
        assert.strictEqual(inline.cid, "logo");
        assert.strictEqual(inline.name, "image.png");
        assert.strictEqual(inline.mime_type, "image/png");
        assert.deepStrictEqual([...Buffer.from(inline.content, "base64")], [1, 2, 3]);
        assert.notInclude(sent.body, "file_cache_key");
        assert.notInclude(sent.body, "client_reference");
      }),
  );

  it.live("preserves maximum reviewed field lengths and a chosen HTML-only alternative", () =>
    Effect.gen(function* preserveZeptomailFieldBoundaries() {
      const fixture = yield* startEmailHttpFixture({
        body: JSON.stringify(acknowledgement),
        status: 200,
      });

      const input = {
        ...message,
        attachments: [
          { contentBase64: "AQID", contentType: "text/plain", filename: `${"x".repeat(146)}.txt` },
        ],
        body: { html: "<p>Literal HTML only</p>" },
        from: { address: message.from.address, name: "界".repeat(250) },
        subject: "界".repeat(500),
      } as const;

      yield* Effect.gen(function* submitZeptomailFieldBoundaries() {
        return yield* (yield* Email).send(input);
      }).pipe(Effect.provide(fixtureZeptomailLayer(fixture)));
      const sent = yield* Queue.take(fixture.received);

      const wire = yield* Schema.decodeEffect(
        Schema.fromJsonString(
          Schema.Struct({
            attachments: Schema.Array(Schema.Struct({ name: Schema.String })),
            from: ZeptomailWireMailbox,
            htmlbody: Schema.String,
            subject: Schema.String,
            textbody: Schema.optionalKey(Schema.String),
          }),
        ),
      )(sent.body);

      assert.strictEqual(wire.from.name, input.from.name);
      assert.strictEqual(wire.subject, input.subject);
      assert.strictEqual(wire.attachments[0]?.name, input.attachments[0].filename);
      assert.strictEqual(wire.htmlbody, input.body.html);
      assert.isUndefined(wire.textbody);
    }),
  );

  it.live.each(["Live", "Sandbox"] as const)(
    "keeps %s acknowledgement terminal without interpreting sandbox logs as delivery",
    (agentMode) =>
      Effect.gen(function* settleZeptomailMode() {
        const primary = yield* startEmailHttpFixture({
          body: JSON.stringify({
            ...acknowledgement,
            private_events: [{ recipient: "private-recipient@example.test", status: "delivered" }],
          }),
          status: 200,
        });

        const backup = yield* startEmailHttpFixture({ body: '{"id":"backup-id"}', status: 200 });

        const receipt = yield* Effect.gen(function* submitZeptomailRoute() {
          return yield* (yield* (yield* EmailRouter).select()).send(message);
        }).pipe(Effect.provide(fixtureZeptomailRoute(primary, backup, agentMode)));

        assert.strictEqual(receipt._tag, agentMode === "Sandbox" ? "Simulated" : "Accepted");
        assert.strictEqual(receipt.route, "primary");
        assert.isTrue(Object.isFrozen(receipt));
        assert.notInclude(JSON.stringify(receipt), "private");
        assert.strictEqual(yield* Queue.size(primary.received), 1);
        assert.strictEqual(yield* Queue.size(backup.received), 0);
      }),
  );

  it.effect(
    "preserves Unicode, JSON escapes and template syntax literally in names, body and subject",
    () =>
      Effect.gen(function* preserveZeptomailLiteralText() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 200,
        });

        const text = '界😀é"\\ {{name}} %recipient.name% *|UNSUB|*';
        yield* Effect.gen(function* submitZeptomailLiteralText() {
          return yield* (yield* Email).send({
            ...message,
            body: { text },
            from: { address: message.from.address, name: text },
            subject: text,
          });
        }).pipe(Effect.provide(fixtureZeptomailLayer(fixture)));
        const sent = yield* Queue.take(fixture.received);

        const wire = yield* Schema.decodeEffect(
          Schema.fromJsonString(
            Schema.Struct({
              from: ZeptomailWireMailbox,
              htmlbody: Schema.optionalKey(Schema.String),
              subject: Schema.String,
              textbody: Schema.String,
            }),
          ),
        )(sent.body);

        assert.strictEqual(wire.from.name, text);
        assert.strictEqual(wire.subject, text);
        assert.strictEqual(wire.textbody, text);
        assert.isUndefined(wire.htmlbody);
      }),
  );

  it.live.each([
    {},
    { request_id: "synthetic-request-id" },
    { ...acknowledgement, request_id: "" },
    { ...acknowledgement, request_id: "private id" },
    { ...acknowledgement, request_id: 123 },
    { ...acknowledgement, message: "error" },
    { ...acknowledgement, object: "batch" },
    { ...acknowledgement, error: { message: "private-reason" } },
    { ...acknowledgement, data: [] },
    { ...acknowledgement, data: [...acknowledgement.data, ...acknowledgement.data] },
    { ...acknowledgement, data: [{ additional_info: [], code: "EM_105" }] },
    { ...acknowledgement, data: [{ code: "EM_104" }] },
    { ...acknowledgement, data: [{ additional_info: null, code: "EM_104" }] },
    {
      ...acknowledgement,
      data: [
        {
          additional_info: [
            { to: { email_address: { address: "private-recipient@example.test" } } },
          ],
          code: "EM_104",
        },
      ],
    },
    {
      ...acknowledgement,
      data: [{ additional_info: [], code: "EM_104", error: "private-reason" }],
    },
  ])(
    "requires complete reviewed acknowledgement instead of guessing from a handle (case %#)",
    (body) =>
      Effect.gen(function* refuseZeptomailUnprovedAcknowledgement() {
        const primary = yield* startEmailHttpFixture({ body: JSON.stringify(body), status: 200 });
        const backup = yield* startEmailHttpFixture({ body: '{"id":"backup-id"}', status: 200 });

        const result = yield* Effect.gen(function* submitUnprovedZeptomailRoute() {
          return yield* (yield* (yield* EmailRouter).select()).send(message);
        }).pipe(Effect.provide(fixtureZeptomailRoute(primary, backup)), Effect.result);

        assert(Result.isFailure(result));
        assert(result.failure instanceof EmailDeliveryUnknown);
        assert.strictEqual(result.failure.reason, "invalid-response");
        assert.notInclude(JSON.stringify(result.failure), "private");
        assert.strictEqual(yield* Queue.size(primary.received), 1);
        assert.strictEqual(yield* Queue.size(backup.received), 0);
      }),
  );

  it.live.each([201, 202, 400, 401, 403, 409, 413, 422, 429, 500, 503])(
    "does not borrow safe fallback/retry from unreviewed HTTP %i",
    (status) =>
      Effect.gen(function* preserveZeptomailStatusUncertainty() {
        const primary = yield* startEmailHttpFixture({
          body: JSON.stringify({
            ...acknowledgement,
            error: { code: "TM_4001", message: "private-reason" },
          }),
          status,
        });

        const backup = yield* startEmailHttpFixture({ body: '{"id":"backup-id"}', status: 200 });

        const result = yield* Effect.gen(function* submitUnreviewedZeptomailStatus() {
          return yield* (yield* (yield* EmailRouter).select()).send(message);
        }).pipe(Effect.provide(fixtureZeptomailRoute(primary, backup)), Effect.result);

        assert(Result.isFailure(result));
        assert(result.failure instanceof EmailDeliveryUnknown);
        assert.strictEqual(result.failure.status, status);
        assert.strictEqual(
          result.failure.reason,
          status >= 500 ? "server-error" : "unexpected-status",
        );
        assert.notInclude(JSON.stringify(result.failure), "private");
        assert.strictEqual(yield* Queue.size(primary.received), 1);
        assert.strictEqual(yield* Queue.size(backup.received), 0);
      }),
  );

  it.live.each([
    { ...message, subject: "x".repeat(501) },
    { ...message, from: { address: message.from.address, name: "x".repeat(251) } },
    { ...message, replyTo: { address: "reply@example.test", name: "x".repeat(251) } },
    { ...message, cc: "RECIPIENT@example.test" },
    { ...message, to: ["recipient@example.test", "RECIPIENT@example.test"] },
    {
      ...message,
      headers: [
        { name: "X-Workflow", value: "a" },
        { name: "x-workflow", value: "b" },
      ],
    },
    { ...message, headers: [{ name: "X-TM-OPEN-TRACK", value: "true" }] },
    { ...message, headers: [{ name: "X-TM-FILE-KEY", value: "private-file" }] },
    { ...message, headers: [{ name: "X-Zoho-Template", value: "private-template" }] },
    { ...message, metadata: { private: "value" } },
    { ...message, tags: [{ name: "workflow", value: "private-value" }] },
    { ...message, sendAt: "2026-10-14T12:30:00Z" },
    {
      ...message,
      attachments: [
        { contentBase64: "AQID", contentType: "ProviderSelected", filename: "sample.txt" },
      ],
    },
    {
      ...message,
      attachments: [
        {
          contentBase64: "AQID",
          contentId: "inline",
          contentType: "text/plain",
          filename: "sample.txt",
        },
      ],
    },
    {
      ...message,
      attachments: [{ contentBase64: "AQID", contentType: "text/plain", filename: "script.PS1" }],
    },
    {
      ...message,
      attachments: [{ contentBase64: "AQID", contentType: "text/plain", filename: "script.jS" }],
    },
    {
      ...message,
      attachments: [
        { contentBase64: "AQID", contentType: "text/plain", filename: `${"x".repeat(147)}.txt` },
      ],
    },
  ] as const)(
    "preflights incompatible routed intent before any candidate submits (case %#)",
    (input) =>
      Effect.gen(function* preflightZeptomailIntent() {
        const primary = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 200,
        });

        const backup = yield* startEmailHttpFixture({ body: '{"id":"backup-id"}', status: 200 });

        const results = yield* Effect.gen(function* validateAndSendZeptomailIntent() {
          const email = yield* (yield* EmailRouter).select();

          return [
            yield* email.validate(input).pipe(Effect.asVoid, Effect.result),
            yield* email.send(input).pipe(Effect.asVoid, Effect.result),
          ];
        }).pipe(Effect.provide(fixtureZeptomailRoute(primary, backup)));

        for (const result of results) {
          assert(Result.isFailure(result));
          assert(result.failure instanceof EmailInvalidMessage);
          assert.notInclude(JSON.stringify(result.failure), "private");
        }

        assert.strictEqual(yield* Queue.size(primary.received), 0);
        assert.strictEqual(yield* Queue.size(backup.received), 0);
      }),
  );

  it.live(
    "bounds actual UTF-8 request JSON including bytes without silently shortening content",
    () =>
      Effect.gen(function* boundZeptomailRequest() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 200,
        });

        yield* Effect.gen(function* submitZeptomailBudgetBoundary() {
          const email = yield* Email;

          const baseline = {
            ...message,
            attachments: [
              {
                contentBase64: Buffer.alloc(1_048_576).toString("base64"),
                contentType: "application/pdf",
                filename: "first.pdf",
              },
              ...[1, 2].map((index) => ({
                contentBase64: Buffer.alloc(1_048_576).toString("base64"),
                contentType: "application/pdf",
                filename: `sample-${index}.pdf`,
              })),
            ] as const,
            body: { html: "x", text: "界".repeat(1_000_000) },
          };

          yield* email.send(baseline);
          const first = yield* Queue.take(fixture.received);
          const available = 8_000_000 - new TextEncoder().encode(first.body).byteLength + 1;
          const html = "界".repeat(Math.floor(available / 3)) + "x".repeat(available % 3);
          yield* email.send({ ...baseline, body: { ...baseline.body, html } });
          const sent = yield* Queue.take(fixture.received);
          assert.strictEqual(new TextEncoder().encode(sent.body).byteLength, 8_000_000);

          const wire = yield* Schema.decodeEffect(
            Schema.fromJsonString(
              Schema.Struct({ htmlbody: Schema.String, textbody: Schema.String }),
            ),
          )(sent.body);

          assert.strictEqual(wire.htmlbody, html);
          assert.strictEqual(wire.textbody, baseline.body.text);

          const result = yield* email
            .send({ ...baseline, body: { ...baseline.body, html: `${html}x` } })
            .pipe(Effect.result);

          assert(Result.isFailure(result));
          assert(result.failure instanceof EmailInvalidMessage);
          assert.strictEqual(yield* Queue.size(fixture.received), 0);
        }).pipe(Effect.provide(fixtureZeptomailLayer(fixture)));
      }),
  );

  it.live("defends unsupported keys at ordinary, all-candidate routed and direct entrypoints", () =>
    Effect.gen(function* defendZeptomailKeys() {
      const primary = yield* startEmailHttpFixture({
        body: JSON.stringify(acknowledgement),
        status: 200,
      });

      const backup = yield* startEmailHttpFixture({ body: '{"id":"backup-id"}', status: 200 });

      const ordinary = yield* Effect.gen(function* sendOrdinaryZeptomailKey() {
        return yield* (yield* Email).send(message, { idempotencyKey: "private-key" });
      }).pipe(Effect.provide(fixtureZeptomailLayer(primary)), Effect.result);

      const routed = yield* Effect.gen(function* sendRoutedZeptomailKey() {
        return yield* (yield* (yield* EmailRouter).select()).send(message, {
          idempotencyKey: "private-key",
        });
      }).pipe(Effect.provide(fixtureZeptomailRoute(primary, backup)), Effect.result);

      const incompatibleBackup = yield* Effect.gen(function* preflightZeptomailBackupKey() {
        return yield* (yield* (yield* EmailRouter).select()).send(message, {
          idempotencyKey: "private-key",
        });
      }).pipe(
        Effect.provide(
          emailRouterLayer(
            [
              {
                layer: resendEmailLayer({ apiKey: Redacted.make("fictional-key") }, policy).pipe(
                  Layer.provide(emailFixtureClientLayer(primary.url, "https://api.resend.com")),
                ),
                name: "primary",
              },
              { layer: fixtureZeptomailLayer(backup), name: "backup" },
            ],
            { fallbacks: ["backup"], primary: "primary" },
          ),
        ),
        Effect.result,
      );

      const direct = yield* Effect.gen(function* sendDirectZeptomailKey() {
        return yield* (yield* EmailSender).submit({
          idempotencyKey: EmailIdempotencyKeySchema.make("private-key"),
          message: yield* parseEmailMessage(message),
        });
      }).pipe(
        Effect.provide(
          zeptomailSenderLayer(options).pipe(
            Layer.provide(emailFixtureClientLayer(primary.url, "https://cpaas.zoho.com")),
          ),
        ),
        Effect.result,
      );

      for (const result of [ordinary, routed, incompatibleBackup, direct]) {
        assert(Result.isFailure(result));
        assert(result.failure instanceof EmailRejected);
        assert.strictEqual(result.failure.reason, "unsupported-idempotency");
        assert.notInclude(JSON.stringify(result.failure), "private-key");
      }

      assert.strictEqual(yield* Queue.size(primary.received), 0);
      assert.strictEqual(yield* Queue.size(backup.received), 0);
    }),
  );

  it.live.each(["", "private key", "private\r\nkey", "Zoho-enczapikey private-key"])(
    "requires a raw printable Redacted key, not an unsafe preformatted authorization value (case %#)",
    (credential) =>
      Effect.gen(function* refuseZeptomailCredential() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 200,
        });

        const result = yield* Effect.service(Email).pipe(
          Effect.provide(
            zeptomailEmailLayer({ ...options, apiKey: Redacted.make(credential) }).pipe(
              Layer.provide(emailFixtureClientLayer(fixture.url, "https://cpaas.zoho.com")),
            ),
          ),
          Effect.result,
        );

        assert(Result.isFailure(result));
        assert(result.failure instanceof EmailConfigurationError);
        assert.notInclude(JSON.stringify(result.failure), "private");
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );

  it.live(
    "requires an explicit agent mode and owns its value and credential after acquisition",
    () =>
      Effect.gen(function* ownZeptomailConfiguration() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 200,
        });

        const missing = { ...options };
        Reflect.deleteProperty(missing, "agentMode");

        const result = yield* Effect.service(Email).pipe(
          Effect.provide(
            zeptomailEmailLayer(missing).pipe(
              Layer.provide(emailFixtureClientLayer(fixture.url, "https://cpaas.zoho.com")),
            ),
          ),
          Effect.result,
        );

        assert(Result.isFailure(result));
        assert(result.failure instanceof EmailConfigurationError);
        const configuration: ZeptomailEmailOptions = { ...options };
        const mutable = { ...configuration };
        yield* Effect.gen(function* mutateZeptomailConfigurationAfterAcquisition() {
          const email = yield* Email;
          mutable.agentMode = "Sandbox";
          mutable.apiKey = Redacted.make("private-mutated-key");
          const receipt = yield* email.send(message);
          assert(EmailReceiptSchema.guards.Accepted(receipt));
        }).pipe(
          Effect.provide(
            zeptomailEmailLayer(mutable, policy).pipe(
              Layer.provide(emailFixtureClientLayer(fixture.url, "https://cpaas.zoho.com")),
            ),
          ),
        );
        const sent = yield* Queue.take(fixture.received);
        assert.strictEqual(sent.authorization, "Zoho-enczapikey fictional-zeptomail-key");
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );
});
