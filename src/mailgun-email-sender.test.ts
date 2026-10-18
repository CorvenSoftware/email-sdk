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
import { TestClock } from "effect/testing";
import { startEmailTraceFixture } from "../test/email-tracing-fixture.js";
import { emailFixtureClientLayer, startEmailHttpFixture } from "../test/email-http-fixture.js";
import type { ReceivedEmailHttpSubmission } from "../test/email-http-fixture.js";
import {
  Email,
  EmailConfigurationError,
  EmailDeliveryUnknown,
  EmailInvalidMessage,
  EmailInvalidOptions,
  EmailSender,
  parseEmailMessage,
  EmailReceiptSchema,
  EmailRejected,
  emailAttachmentFromBytes,
} from "./index.js";
import {
  mailgunEmailLayer,
  mailgunPersonalizedEmailLayer,
  mailgunSenderLayer,
} from "./mailgun-email-sender.js";

const message = {
  body: { html: '<p>Fictional café <img src="cid:logo.dat" /></p>', text: "Fictional café" },
  from: "sender@example.test",
  subject: "Synthetic Mailgun notification",
  to: "recipient@example.test",
} as const;

const policy = {
  deadline: Duration.seconds(5),
  initialDelay: Duration.millis(100),
  maxAttempts: 1,
};

describe("Mailgun local multipart HTTP wire", () => {
  it.live.each([
    { origin: "https://api.mailgun.net", region: "UnitedStates" },
    { origin: "https://api.eu.mailgun.net", region: "Europe" },
  ] as const)(
    "submits complete binary and rich intent through the $region domain endpoint",
    ({ origin, region }) =>
      Effect.gen(function* observeMailgunMultipart() {
        const fixture = yield* startEmailHttpFixture({
          body: '{"id":"<synthetic-id@mg.example.test>","message":"Queued. Thank you."}',
          status: 200,
        });

        const receipt = yield* Effect.gen(function* submitMultipartNotification() {
          const inline = yield* emailAttachmentFromBytes(new Uint8Array([0, 255, 128, 10]), {
            contentId: "logo.dat",
            contentType: "application/octet-stream",
            filename: "logo.dat",
          });

          const attachment = yield* emailAttachmentFromBytes(
            new TextEncoder().encode("Fictional café"),
            {
              contentType: "text/plain",
              disposition: "attachment",
              filename: "note.txt",
            },
          );

          return yield* (yield* Email).send({
            ...message,
            attachments: [inline, attachment],
            bcc: "hidden@example.test",
            cc: { address: "copy@example.test", name: "Fictional Copy" },
            from: { address: message.from, name: 'Fictional, "Café"' },
            headers: [
              { name: "X-Workflow", value: "first" },
              { name: "X-Workflow", value: "second" },
            ],
            metadata: { label: "Café", workflow: "synthetic" },
            replyTo: [
              "reply@example.test",
              { address: "another-reply@example.test", name: "Another Reply" },
            ],
            sendAt: "2026-10-13T12:30:00Z",
            tags: [
              { name: "workflow", value: "synthetic value" },
              { name: "purpose", value: "fixture" },
            ],
            to: [message.to, { address: "other@example.test", name: "Another Recipient" }],
          });
        }).pipe(
          Effect.provide(
            mailgunEmailLayer(
              { apiKey: Redacted.make("fictional-token"), domain: "mg.example.test", region },
              policy,
            ).pipe(Layer.provide(emailFixtureClientLayer(fixture.url, origin))),
          ),
        );

        const request = yield* Queue.take(fixture.received);

        const response = new Response(Buffer.from(request.bodyBase64, "base64"), {
          headers: { "Content-Type": request.contentType },
        });

        const fields = yield* Effect.promise(response.formData.bind(response));

        assert.strictEqual(request.method, "POST");
        assert.strictEqual(request.path, "/v3/mg.example.test/messages");
        assert.strictEqual(
          Buffer.from(request.authorization.replace("Basic ", ""), "base64").toString("utf-8"),
          "api:fictional-token",
        );
        assert.strictEqual(request.idempotencyKey, "");
        assert.strictEqual(fields.get("from"), '"Fictional, \\"Café\\"" <sender@example.test>');
        assert.deepStrictEqual(fields.getAll("to"), [
          message.to,
          '"Another Recipient" <other@example.test>',
        ]);
        assert.deepStrictEqual(fields.getAll("cc"), ['"Fictional Copy" <copy@example.test>']);
        assert.deepStrictEqual(fields.getAll("bcc"), ["hidden@example.test"]);
        assert.deepStrictEqual(fields.getAll("h:Reply-To"), [
          "reply@example.test",
          '"Another Reply" <another-reply@example.test>',
        ]);
        assert.deepStrictEqual(fields.getAll("h:X-Workflow"), ["first", "second"]);
        assert.strictEqual(fields.get("subject"), message.subject);
        assert.strictEqual(fields.get("text"), message.body.text);
        assert.strictEqual(fields.get("html"), message.body.html);
        assert.strictEqual(fields.get("v:workflow"), "synthetic");
        assert.strictEqual(fields.get("v:label"), "Café");
        assert.deepStrictEqual(fields.getAll("o:tag"), [
          "workflow:synthetic value",
          "purpose:fixture",
        ]);
        assert.strictEqual(fields.get("o:deliverytime"), "Tue, 13 Oct 2026 12:30:00 GMT");
        assert.strictEqual(fields.get("o:tracking"), "no");
        assert.strictEqual(fields.get("o:tracking-clicks"), "no");
        assert.strictEqual(fields.get("o:tracking-opens"), "no");
        assert.strictEqual(fields.get("o:testmode"), null);

        const inline = yield* Schema.decodeUnknownEffect(Schema.instanceOf(File))(
          fields.get("inline"),
        );

        const attachment = yield* Schema.decodeUnknownEffect(Schema.instanceOf(File))(
          fields.get("attachment"),
        );

        assert.strictEqual(inline.name, "logo.dat");
        assert.strictEqual(inline.type, "application/octet-stream");
        assert.deepStrictEqual(
          [...new Uint8Array(yield* Effect.promise(inline.arrayBuffer.bind(inline)))],
          [0, 255, 128, 10],
        );
        assert.strictEqual(attachment.name, "note.txt");
        assert.strictEqual(attachment.type, "text/plain");
        assert.strictEqual(
          yield* Effect.promise(attachment.text.bind(attachment)),
          "Fictional café",
        );
        assert(EmailReceiptSchema.guards.Accepted(receipt));
        assert.strictEqual(receipt.provider, "mailgun");
        assert.strictEqual(receipt.messageId, "<synthetic-id@mg.example.test>");
      }),
  );

  it.live.each([
    {
      body: '{"message":"private response without id"}',
      reason: "invalid-response",
      status: 200,
      unknown: true,
    },
    { body: '{"id":"misleading-id"}', reason: "unexpected-status", status: 202, unknown: true },
    {
      body: '{"message":"private invalid recipient"}',
      reason: "invalid-message",
      status: 400,
      unknown: false,
    },
    { body: '{"message":"private key"}', reason: "authentication", status: 401, unknown: false },
    { body: '{"message":"private domain"}', reason: "authentication", status: 403, unknown: false },
    { body: '{"message":"private domain"}', reason: "rejected", status: 404, unknown: false },
    { body: '{"message":"private quota"}', reason: "rate-limited", status: 429, unknown: false },
    {
      body: '{"message":"private timeout"}',
      reason: "unexpected-status",
      status: 408,
      unknown: true,
    },
    { body: '{"message":"private server"}', reason: "server-error", status: 503, unknown: true },
  ])("classifies $status/$reason without interpreting uncertainty as non-submission", (scenario) =>
    Effect.gen(function* classifyMailgunEvidence() {
      const fixture = yield* startEmailHttpFixture({ ...scenario, retryAfter: "12" });

      const failure = yield* Effect.gen(function* submitClassifiedNotification() {
        return yield* (yield* Email).send(message);
      }).pipe(
        Effect.provide(
          mailgunEmailLayer(
            { apiKey: Redacted.make("fictional-token"), domain: "mg.example.test" },
            policy,
          ).pipe(Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.mailgun.net"))),
        ),
        Effect.flip,
      );

      assert(Schema.is(EmailDeliveryUnknown)(failure) || Schema.is(EmailRejected)(failure));
      assert.strictEqual(Schema.is(EmailDeliveryUnknown)(failure), scenario.unknown);
      assert.strictEqual(failure.reason, scenario.reason);
      assert.notInclude(JSON.stringify(failure), "private");

      if (Schema.is(EmailRejected)(failure) && scenario.status === 429) {
        assert.strictEqual(failure.retryAfterMillis, 12_000);
      }

      assert.strictEqual(yield* Queue.size(fixture.received), 1);
    }),
  );

  it.live("rejects unsafe credentials/domains and unsupported keys before emitting a request", () =>
    Effect.gen(function* rejectUnsafeMailgunConfiguration() {
      const fixture = yield* startEmailHttpFixture({ body: '{"id":"not-used"}', status: 200 });
      const client = emailFixtureClientLayer(fixture.url, "https://api.mailgun.net");

      for (const configuration of [
        { apiKey: Redacted.make("private token"), domain: "mg.example.test" },
        { apiKey: Redacted.make("fictional-token"), domain: "private.example.test/../messages" },
      ]) {
        const failure = yield* Effect.service(Email).pipe(
          Effect.provide(mailgunEmailLayer(configuration).pipe(Layer.provide(client))),
          Effect.flip,
        );

        assert(Schema.is(EmailConfigurationError)(failure));
        assert.notInclude(JSON.stringify(failure), "private");
      }

      const failure = yield* Effect.gen(function* submitUnsupportedKey() {
        return yield* (yield* Email).send(message, { idempotencyKey: "private-key" });
      }).pipe(
        Effect.provide(
          mailgunEmailLayer({
            apiKey: Redacted.make("fictional-token"),
            domain: "mg.example.test",
          }).pipe(Layer.provide(client)),
        ),
        Effect.flip,
      );

      assert(Schema.is(EmailRejected)(failure));
      assert.strictEqual(failure.reason, "unsupported-idempotency");
      assert.strictEqual(yield* Queue.size(fixture.received), 0);
    }),
  );

  it.effect.each(["X-Mailgun-Recipient-Variables", "x-mailgun-variables"])(
    "refuses reserved %s controls during preflight, ordinary sends and direct submission",
    (name) =>
      Effect.gen(function* refuseMailgunControlHeaders() {
        const fixture = yield* startEmailHttpFixture({ body: '{"id":"not-used"}', status: 200 });
        const options = { apiKey: Redacted.make("fictional-token"), domain: "mg.example.test" };

        const input = {
          ...message,
          headers: [{ name, value: "private-provider-override" }] as const,
        };

        yield* Effect.gen(function* rejectMailgunControlOverride() {
          const email = yield* Email;
          assert((yield* email.validate(input).pipe(Effect.flip)) instanceof EmailInvalidMessage);
          assert((yield* email.send(input).pipe(Effect.flip)) instanceof EmailInvalidMessage);
        }).pipe(
          Effect.provide(
            mailgunEmailLayer(options).pipe(
              Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.mailgun.net")),
            ),
          ),
        );

        const direct = yield* Effect.gen(function* rejectDirectMailgunControlOverride() {
          const owned = yield* parseEmailMessage(input);

          return yield* (yield* EmailSender).submit({ message: owned });
        }).pipe(
          Effect.provide(
            mailgunSenderLayer(options).pipe(
              Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.mailgun.net")),
            ),
          ),
          Effect.flip,
        );

        assert(direct instanceof EmailRejected);
        assert.strictEqual(direct.reason, "invalid-message");
        assert.notInclude(JSON.stringify(direct), "private-provider-override");
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );
});

const nativeTemplate = {
  body: {
    html: "<p>%recipient.name% / %recipient.active%</p>",
    text: "%recipient.name% / %recipient.active%",
  },
  from: { address: "sender@example.test", name: "Fictional Café" },
  subject: "Hello %recipient.name%",
} as const;

const nativeRecipients = [
  {
    to: { address: "First@example.test", name: "First Name" },
    variables: { active: false, name: "A<&\"'" },
  },
  { to: "second@example.test", variables: { active: true, name: "B" } },
] as const;

const NativeVariables = Schema.Record(
  Schema.String,
  Schema.Struct({
    corven_html: Schema.optionalKey(Schema.String),
    corven_subject: Schema.String,
    corven_text: Schema.optionalKey(Schema.String),
  }),
);

const readNativeVariables = Schema.decodeUnknownEffect(Schema.fromJsonString(NativeVariables));

const readMailgunMultipart = Effect.fnUntraced(function* readMailgunMultipart(
  request: ReceivedEmailHttpSubmission,
) {
  const response = new Response(Buffer.from(request.bodyBase64, "base64"), {
    headers: { "Content-Type": request.contentType },
  });

  return yield* Effect.promise(response.formData.bind(response));
});

describe("Mailgun native personalization", () => {
  it.effect.each([
    { origin: "https://api.mailgun.net", region: "UnitedStates" },
    { origin: "https://api.eu.mailgun.net", region: "Europe" },
  ] as const)(
    "sends one private native $region audience with complete literal bodies and rich multipart fields",
    ({ origin, region }) =>
      Effect.gen(function* sendNativeMailgunAudience() {
        const fixture = yield* startEmailHttpFixture({
          body: '{"id":"<batch@mg.example.test>"}',
          status: 200,
        });

        const trace = yield* startEmailTraceFixture();

        const outcomes = yield* Effect.gen(function* submitRichNativeMailgunAudience() {
          const attachment = yield* emailAttachmentFromBytes(new Uint8Array([0, 255, 128, 10]), {
            contentId: "logo.dat",
            contentType: "application/octet-stream",
            filename: "logo.dat",
          });

          return yield* (yield* Email).sendPersonalized(
            {
              message: {
                ...nativeTemplate,
                attachments: [attachment],
                headers: [
                  { name: "X-Workflow", value: "first" },
                  { name: "X-Workflow", value: "second" },
                ],
                metadata: { workflow: "private-native-metadata" },
                replyTo: [
                  { address: "reply@example.test", name: "Reply Café" },
                  "other-reply@example.test",
                ],
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
            mailgunPersonalizedEmailLayer(
              {
                apiKey: Redacted.make("private-fictional-token"),
                domain: "mg.example.test",
                region,
              },
              policy,
            ).pipe(Layer.provide(emailFixtureClientLayer(fixture.url, origin))),
          ),
          Effect.withTracer(trace.tracer),
        );

        assert.strictEqual(outcomes.length, 2);

        for (const outcome of outcomes) {
          assert(Result.isSuccess(outcome));
          assert(EmailReceiptSchema.guards.Accepted(outcome.success));
          assert.strictEqual(outcome.success.provider, "mailgun");
          assert.notProperty(outcome.success, "messageId");
          assert.strictEqual(outcome.success.submissionId, "<batch@mg.example.test>");
          assert(Object.isFrozen(outcome.success));
        }

        const request = yield* Queue.take(fixture.received);
        const fields = yield* readMailgunMultipart(request);
        const variables = yield* readNativeVariables(fields.get("recipient-variables"));
        assert.notInclude(request.body, "private-personalized-context");
        assert.notInclude(request.body, "private-personalized-nested-context");
        assert.notInclude(request.body, "executionMetadata");
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
        assert.strictEqual(request.path, "/v3/mg.example.test/messages");
        assert.strictEqual(
          Buffer.from(request.authorization.replace("Basic ", ""), "base64").toString(),
          "api:private-fictional-token",
        );
        assert.strictEqual(request.idempotencyKey, "");
        assert.deepStrictEqual(fields.getAll("to"), [
          '"First Name" <First@example.test>',
          "second@example.test",
        ]);
        assert.deepStrictEqual(Object.keys(variables), [
          "First@example.test",
          "second@example.test",
        ]);
        const first = variables["First@example.test"];
        const second = variables["second@example.test"];
        assert.isDefined(first);
        assert.isDefined(second);
        assert.strictEqual(fields.get("subject"), "%recipient.corven_subject%");
        assert.strictEqual(fields.get("text"), "%recipient.corven_text%");
        assert.strictEqual(fields.get("html"), "%recipient.corven_html%");
        assert.strictEqual(first.corven_subject, "Hello A<&\"'");
        assert.strictEqual(first.corven_text, "A<&\"' / false");
        assert.strictEqual(first.corven_html, "<p>A&lt;&amp;&quot;&#39; / false</p>");
        assert.strictEqual(second.corven_html, "<p>B / true</p>");
        assert.deepStrictEqual(fields.getAll("cc"), []);
        assert.deepStrictEqual(fields.getAll("bcc"), []);
        assert.strictEqual(fields.get("from"), '"Fictional Café" <sender@example.test>');
        assert.deepStrictEqual(fields.getAll("h:X-Workflow"), ["first", "second"]);
        assert.deepStrictEqual(fields.getAll("h:Reply-To"), [
          '"Reply Café" <reply@example.test>',
          "other-reply@example.test",
        ]);
        assert.strictEqual(fields.get("v:workflow"), "private-native-metadata");
        assert.strictEqual(fields.get("o:tag"), "channel:native");
        assert.strictEqual(fields.get("o:deliverytime"), "Thu, 01 Jan 1970 00:01:00 GMT");
        assert.strictEqual(fields.get("o:tracking"), "no");
        assert.strictEqual(fields.get("o:tracking-clicks"), "no");
        assert.strictEqual(fields.get("o:tracking-opens"), "no");
        assert.strictEqual(fields.get("o:testmode"), null);
        assert.strictEqual(fields.get("template"), null);
        assert.strictEqual(fields.get("t:variables"), null);

        const inline = yield* Schema.decodeUnknownEffect(Schema.instanceOf(File))(
          fields.get("inline"),
        );

        assert.strictEqual(inline.name, "logo.dat");
        assert.strictEqual(inline.type, "application/octet-stream");
        assert.deepStrictEqual(
          [...new Uint8Array(yield* Effect.promise(inline.arrayBuffer.bind(inline)))],
          [0, 255, 128, 10],
        );
        const diagnostics = yield* trace.diagnostics;

        for (const value of [
          "private-fictional-token",
          "private-native-metadata",
          "First@example.test",
          "<batch@mg.example.test>",
          "A<&",
        ]) {
          assert.notInclude(diagnostics, value);
        }
      }),
  );

  it.effect(
    "keeps ordered local failures and never includes invalid or keyed recipients in the native dictionary",
    () =>
      Effect.gen(function* settleMixedNativeMailgunInput() {
        const fixture = yield* startEmailHttpFixture({
          body: '{"id":"<batch@mg.example.test>"}',
          status: 200,
        });

        const outcomes = yield* Effect.gen(function* submitMixedNativeMailgunAudience() {
          return yield* (yield* Email).sendPersonalized({
            message: nativeTemplate,
            recipients: [
              nativeRecipients[0],
              { to: "missing@example.test", variables: { active: false } },
              {
                to: "literal@example.test",
                variables: { active: false, name: "%recipient.corven_html%" },
              },
              { ...nativeRecipients[1], idempotencyKey: "unsupported-key" },
              { to: "last@example.test", variables: { active: false, name: "Last" } },
            ],
          });
        }).pipe(
          Effect.provide(
            mailgunPersonalizedEmailLayer(
              { apiKey: Redacted.make("fictional-token"), domain: "mg.example.test" },
              policy,
            ).pipe(Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.mailgun.net"))),
          ),
        );

        assert.deepStrictEqual(
          outcomes.map((item) =>
            Result.match(item, {
              onFailure: (failure) => failure._tag,
              onSuccess: (receipt) => receipt._tag,
            }),
          ),
          ["Accepted", "EmailInvalidMessage", "EmailInvalidMessage", "EmailRejected", "Accepted"],
        );
        const fields = yield* readMailgunMultipart(yield* Queue.take(fixture.received));
        const variables = yield* readNativeVariables(fields.get("recipient-variables"));
        assert.deepStrictEqual(Object.keys(variables), ["First@example.test", "last@example.test"]);
        assert.deepStrictEqual(fields.getAll("to"), [
          '"First Name" <First@example.test>',
          "last@example.test",
        ]);
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );

  it.effect.each([
    { body: '{"id":"<batch@mg.example.test>"}', status: 200, tag: "Accepted" },
    { body: '{"message":"private missing id"}', status: 200, tag: "EmailDeliveryUnknown" },
    { body: '{"id":"<not-accepted>"}', status: 202, tag: "EmailDeliveryUnknown" },
    { body: "private rejection", status: 400, tag: "EmailRejected" },
    { body: "private credentials", status: 401, tag: "EmailRejected" },
    { body: "private quota", status: 429, tag: "EmailRejected" },
    { body: "private server", status: 503, tag: "EmailDeliveryUnknown" },
  ])("preserves shared $status/$tag evidence without inventing per-recipient outcomes", (reply) =>
    Effect.gen(function* classifyNativeMailgunProof() {
      const fixture = yield* startEmailHttpFixture(reply);

      const outcomes = yield* Effect.gen(function* submitNativeMailgunStatus() {
        return yield* (yield* Email).sendPersonalized({
          message: nativeTemplate,
          recipients: nativeRecipients,
        });
      }).pipe(
        Effect.provide(
          mailgunPersonalizedEmailLayer(
            { apiKey: Redacted.make("fictional-token"), domain: "mg.example.test" },
            policy,
          ).pipe(Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.mailgun.net"))),
        ),
      );

      assert.strictEqual(outcomes.length, 2);

      for (const outcome of outcomes) {
        assert.strictEqual(
          Result.match(outcome, {
            onFailure: (failure) => failure._tag,
            onSuccess: (receipt) => receipt._tag,
          }),
          reply.tag,
        );
        assert.notInclude(JSON.stringify(outcome), "private");
      }

      assert.strictEqual(yield* Queue.size(fixture.received), 1);
    }),
  );

  it.effect("never uploads a native audience to a redirected destination", () =>
    Effect.gen(function* refuseRedirectedNativeMailgunUpload() {
      const destination = yield* startEmailHttpFixture({
        body: '{"id":"<wrong-destination>"}',
        status: 200,
      });

      const primary = yield* startEmailHttpFixture({
        body: "",
        location: `${destination.url}/redirected`,
        status: 307,
      });

      const outcomes = yield* Effect.gen(function* submitRedirectedNativeMailgunAudience() {
        return yield* (yield* Email).sendPersonalized({
          message: nativeTemplate,
          recipients: nativeRecipients,
        });
      }).pipe(
        Effect.provide(
          mailgunPersonalizedEmailLayer(
            { apiKey: Redacted.make("fictional-token"), domain: "mg.example.test" },
            { ...policy, maxAttempts: 3 },
          ).pipe(Layer.provide(emailFixtureClientLayer(primary.url, "https://api.mailgun.net"))),
        ),
      );

      assert(
        outcomes.every(
          (item) =>
            Result.isFailure(item) &&
            item.failure instanceof EmailDeliveryUnknown &&
            item.failure.reason === "unexpected-status",
        ),
      );
      assert.strictEqual(yield* Queue.size(primary.received), 1);
      assert.strictEqual(yield* Queue.size(destination.received), 0);
    }),
  );

  it.effect(
    "retains ordinary preflight and individual batch sends without native variable injection",
    () =>
      Effect.gen(function* preserveOrdinaryNativeLayerMethods() {
        const fixture = yield* startEmailHttpFixture({
          body: '{"id":"<ordinary@mg.example.test>"}',
          status: 200,
        });

        yield* Effect.gen(function* submitOrdinaryMailgunBatch() {
          const email = yield* Email;
          yield* email.validate(message);
          assert.strictEqual(yield* Queue.size(fixture.received), 0);
          const outcomes = yield* email.sendAll([{ message }, { message }], { concurrency: 1 });
          assert.strictEqual(outcomes.length, 2);

          for (const outcome of outcomes) {
            assert(Result.isSuccess(outcome));
            assert(EmailReceiptSchema.guards.Accepted(outcome.success));
            assert.strictEqual(outcome.success.messageId, "<ordinary@mg.example.test>");
            assert.notProperty(outcome.success, "submissionId");
          }
        }).pipe(
          Effect.provide(
            mailgunPersonalizedEmailLayer(
              { apiKey: Redacted.make("fictional-token"), domain: "mg.example.test" },
              policy,
            ).pipe(Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.mailgun.net"))),
          ),
        );

        for (let index = 0; index < 2; index += 1) {
          const fields = yield* readMailgunMultipart(yield* Queue.take(fixture.received));
          assert.strictEqual(fields.get("recipient-variables"), null);
          assert.strictEqual(fields.get("subject"), message.subject);
          assert.strictEqual(fields.get("text"), message.body.text);
          assert.deepStrictEqual(fields.getAll("to"), [message.to]);
        }

        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );

  it.effect.each([503, 200])(
    "does not replay native uncertainty under a multi-attempt policy after %s",
    (status) =>
      Effect.gen(function* refuseNativeMailgunReplay() {
        const fixture = yield* startEmailHttpFixture({
          body: "{}",
          next: { body: '{"id":"<later>"}', status: 200 },
          status,
        });

        const outcomes = yield* Effect.gen(function* submitUncertainMailgunAudience() {
          return yield* (yield* Email).sendPersonalized({
            message: nativeTemplate,
            recipients: nativeRecipients,
          });
        }).pipe(
          Effect.provide(
            mailgunPersonalizedEmailLayer(
              { apiKey: Redacted.make("fictional-token"), domain: "mg.example.test" },
              { ...policy, maxAttempts: 3 },
            ).pipe(Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.mailgun.net"))),
          ),
        );

        assert(
          outcomes.every(
            (item) => Result.isFailure(item) && item.failure instanceof EmailDeliveryUnknown,
          ),
        );
        assert.strictEqual(yield* Queue.size(fixture.received), 1);
      }),
  );

  it.effect(
    "owns multipart intent before rejection-only backoff, including variables, metadata, dates and bytes",
    () =>
      Effect.gen(function* ownNativeMailgunRetries() {
        const fixture = yield* startEmailHttpFixture({
          body: "",
          next: { body: '{"id":"<after-rejection>"}', status: 200 },
          status: 429,
        });

        const ready = yield* Deferred.make<boolean>();
        const release = yield* Deferred.make<boolean>();

        const recipient = {
          to: "recipient@example.test",
          variables: { active: false, name: "Before" },
        };

        const attachment = {
          contentBase64: "AP8=",
          contentType: "application/octet-stream",
          filename: "before.dat",
        };

        const input = {
          message: {
            ...nativeTemplate,
            attachments: [attachment] as const,
            metadata: { state: "Before" },
            sendAt: new Date(60_000),
          },
          recipients: [recipient] as const,
        };

        const fiber = yield* Effect.gen(function* submitRetriedNativeMailgunAudience() {
          return yield* (yield* Email).sendPersonalized(input);
        }).pipe(
          Effect.provide(
            mailgunPersonalizedEmailLayer(
              { apiKey: Redacted.make("fictional-token"), domain: "mg.example.test" },
              { ...policy, maxAttempts: 2 },
              () => Deferred.succeed(ready, true).pipe(Effect.andThen(Deferred.await(release))),
            ).pipe(Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.mailgun.net"))),
          ),
          Effect.forkScoped,
        );

        yield* Deferred.await(ready);
        recipient.variables.name = "After";
        input.message.metadata.state = "After";
        input.message.sendAt.setTime(120_000);
        attachment.contentBase64 = "AQ==";
        attachment.filename = "after.dat";
        yield* Deferred.succeed(release, true);
        yield* TestClock.adjust(Duration.seconds(1));
        const outcomes = yield* Fiber.join(fiber);
        assert(outcomes.every(Result.isSuccess));
        const first = yield* readMailgunMultipart(yield* Queue.take(fixture.received));
        const second = yield* readMailgunMultipart(yield* Queue.take(fixture.received));
        assert.strictEqual(first.get("recipient-variables"), second.get("recipient-variables"));
        assert.strictEqual(second.get("v:state"), "Before");
        assert.strictEqual(second.get("o:deliverytime"), "Thu, 01 Jan 1970 00:01:00 GMT");
        const variables = yield* readNativeVariables(second.get("recipient-variables"));
        assert.strictEqual(variables["recipient@example.test"]?.corven_subject, "Hello Before");

        const file = yield* Schema.decodeUnknownEffect(Schema.instanceOf(File))(
          second.get("attachment"),
        );

        assert.strictEqual(file.name, "before.dat");
        assert.deepStrictEqual(
          [...new Uint8Array(yield* Effect.promise(file.arrayBuffer.bind(file)))],
          [0, 255],
        );
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );

  it.effect.each(["interrupt", "deadline"] as const)(
    "cleans up an active multipart request on $0 without ordinary false success",
    (control) =>
      Effect.gen(function* cancelNativeMailgunRequest() {
        const fixture = yield* startEmailHttpFixture({ body: "", hold: true, status: 200 });

        const fiber = yield* Effect.gen(function* submitHeldMailgunAudience() {
          return yield* (yield* Email).sendPersonalized({
            message: nativeTemplate,
            recipients: nativeRecipients,
          });
        }).pipe(
          Effect.provide(
            mailgunPersonalizedEmailLayer(
              { apiKey: Redacted.make("fictional-token"), domain: "mg.example.test" },
              policy,
            ).pipe(Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.mailgun.net"))),
          ),
          Effect.forkScoped,
        );

        yield* Queue.take(fixture.received);

        if (control === "interrupt") {
          yield* Fiber.interrupt(fiber);
          const exit = yield* Fiber.await(fiber);
          assert(Exit.isFailure(exit));
          assert(Cause.hasInterrupts(exit.cause));
        } else {
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
        }

        assert.strictEqual(yield* Queue.take(fixture.closed), true);
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );

  it.effect(
    "supports common large bodies and refuses an oversized UTF-8 variable dictionary before transport",
    () =>
      Effect.gen(function* boundNativeMailgunVariables() {
        const fixture = yield* startEmailHttpFixture({ body: '{"id":"<large>"}', status: 200 });
        const body = "é".repeat(500_000);

        const template = {
          body: { text: body },
          from: "sender@example.test",
          subject: "Native large body",
        };

        const recipient = { to: "first@example.test", variables: {} };
        yield* Effect.gen(function* submitBoundedNativeMailgunVariables() {
          const email = yield* Email;
          const one = yield* email.sendPersonalized({ message: template, recipients: [recipient] });
          assert(one.every(Result.isSuccess));

          const many = yield* email.sendPersonalized({
            message: template,
            recipients: [
              recipient,
              ...Array.from({ length: 17 }, (_, index) => ({
                to: `large${index}@example.test`,
                variables: {},
              })),
            ],
          });

          assert.strictEqual(many.length, 18);
          assert(
            many.every(
              (item) => Result.isFailure(item) && item.failure instanceof EmailInvalidMessage,
            ),
          );
        }).pipe(
          Effect.provide(
            mailgunPersonalizedEmailLayer(
              { apiKey: Redacted.make("fictional-token"), domain: "mg.example.test" },
              policy,
            ).pipe(Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.mailgun.net"))),
          ),
        );
        const fields = yield* readMailgunMultipart(yield* Queue.take(fixture.received));
        const variables = yield* readNativeVariables(fields.get("recipient-variables"));
        assert.strictEqual(variables["first@example.test"]?.corven_text, body);
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );

  it.effect(
    "preflights duplicate audiences, invalid options, metadata interpolation and reserved batch overrides without HTTP",
    () =>
      Effect.gen(function* refuseNativeMailgunLocalAmbiguity() {
        const fixture = yield* startEmailHttpFixture({ body: '{"id":"<unused>"}', status: 200 });
        yield* Effect.gen(function* rejectNativeMailgunAmbiguity() {
          const email = yield* Email;
          assert(
            (yield* email
              .sendPersonalized(
                { message: nativeTemplate, recipients: nativeRecipients },
                { concurrency: 0 },
              )
              .pipe(Effect.flip)) instanceof EmailInvalidOptions,
          );
          assert(
            (yield* email
              .sendPersonalized({
                message: nativeTemplate,
                recipients: [nativeRecipients[0], nativeRecipients[0]],
              })
              .pipe(Effect.flip)) instanceof EmailInvalidMessage,
          );

          const metadata = yield* email.sendPersonalized({
            message: { ...nativeTemplate, metadata: { privateKey: "%recipient.corven_subject%" } },
            recipients: nativeRecipients,
          });

          const headers = yield* email.sendPersonalized({
            message: {
              ...nativeTemplate,
              headers: [{ name: "X-Mailgun-Recipient-Variables", value: "private-dictionary" }],
            },
            recipients: nativeRecipients,
          });

          for (const results of [metadata, headers]) {
            assert(
              results.every(
                (item) => Result.isFailure(item) && item.failure instanceof EmailInvalidMessage,
              ),
            );
            assert.notInclude(JSON.stringify(results), "private");
          }
        }).pipe(
          Effect.provide(
            mailgunPersonalizedEmailLayer({
              apiKey: Redacted.make("fictional-token"),
              domain: "mg.example.test",
            }).pipe(Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.mailgun.net"))),
          ),
        );
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );

  it.effect(
    "supports the full common 500-recipient audience with exactly matched private variable membership",
    () =>
      Effect.gen(function* submitLargestNativeMailgunAudience() {
        const fixture = yield* startEmailHttpFixture({ body: '{"id":"<audience>"}', status: 200 });

        const recipients = [
          { to: "first@example.test", variables: { active: false, name: "First" } },
          ...Array.from({ length: 499 }, (_, index) => ({
            to: `r${index}@example.test`,
            variables: { active: true, name: String(index) },
          })),
        ] as const;

        yield* Effect.gen(function* submitCompleteNativeMailgunAudience() {
          const email = yield* Email;
          const results = yield* email.sendPersonalized({ message: nativeTemplate, recipients });
          assert.strictEqual(results.length, 500);
          assert(results.every(Result.isSuccess));
          assert(
            (yield* email
              .sendPersonalized({
                message: nativeTemplate,
                recipients: [
                  ...recipients,
                  { to: "overflow@example.test", variables: { active: false, name: "Overflow" } },
                ],
              })
              .pipe(Effect.flip)) instanceof EmailInvalidMessage,
          );
        }).pipe(
          Effect.provide(
            mailgunPersonalizedEmailLayer(
              { apiKey: Redacted.make("fictional-token"), domain: "mg.example.test" },
              policy,
            ).pipe(Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.mailgun.net"))),
          ),
        );
        const fields = yield* readMailgunMultipart(yield* Queue.take(fixture.received));
        const variables = yield* readNativeVariables(fields.get("recipient-variables"));
        assert.deepStrictEqual(
          Object.keys(variables),
          recipients.map((recipient) => recipient.to),
        );
        assert.deepStrictEqual(
          fields.getAll("to"),
          recipients.map((recipient) => recipient.to),
        );
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );

  it.effect.prop(
    "preserves generated Unicode, JSON escaping and line breaks through the native multipart variable dictionary",
    {
      characters: Schema.NonEmptyArray(
        Schema.Literals(["A", "é", "😀", "<", ">", "&", "'", '"', "\\", "\n", "\r\n"]),
      ).check(Schema.isMaxLength(16)),
    },
    ({ characters }) =>
      Effect.gen(function* preserveGeneratedNativeMailgunContent() {
        const fixture = yield* startEmailHttpFixture({ body: '{"id":"<generated>"}', status: 200 });
        const name = `<script>${characters.join("")}</script>`;

        const results = yield* Effect.gen(function* submitGeneratedNativeMailgunAudience() {
          return yield* (yield* Email).sendPersonalized({
            message: { ...nativeTemplate, subject: "Generated literal body" },
            recipients: [{ to: "recipient@example.test", variables: { active: false, name } }],
          });
        }).pipe(
          Effect.provide(
            mailgunPersonalizedEmailLayer(
              { apiKey: Redacted.make("fictional-token"), domain: "mg.example.test" },
              policy,
            ).pipe(Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.mailgun.net"))),
          ),
        );

        assert(results.every(Result.isSuccess));
        const fields = yield* readMailgunMultipart(yield* Queue.take(fixture.received));
        const variables = yield* readNativeVariables(fields.get("recipient-variables"));
        const recipient = variables["recipient@example.test"];
        assert.isDefined(recipient);
        assert.strictEqual(recipient.corven_text, `${name} / false`);
        assert.isDefined(recipient.corven_html);
        assert.include(recipient.corven_html, "&lt;script&gt;");
        assert.notInclude(recipient.corven_html, "<script>");
      }),
    { arbitrary: { runs: 24 } },
  );
});
