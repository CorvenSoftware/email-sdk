import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Layer, Queue, Redacted, Result, Schema } from "effect";
import { emailFixtureClientLayer, startEmailHttpFixture } from "../test/email-http-fixture.js";
import {
  Email,
  emailAttachmentFromBytes,
  EmailConfigurationError,
  EmailDeliveryUnknown,
  EmailReceiptSchema,
  EmailRejected,
} from "./index.js";
import { postmarkEmailLayer, preflightPostmarkEmail } from "./postmark-email-sender.js";

const clientLayer = (url: string) => emailFixtureClientLayer(url, "https://api.postmarkapp.com");

const message = {
  body: { html: "<p>Fictional café &amp; welcome</p>", text: "Fictional café & welcome" },
  from: "sender@example.test",
  subject: "Synthetic Postmark example",
  to: ["recipient@example.test", "other@example.test"],
} as const;

const ReceivedPostmarkEmail = Schema.Struct({
  Attachments: Schema.Array(
    Schema.Struct({
      Content: Schema.String,
      ContentID: Schema.optionalKey(Schema.String),
      ContentType: Schema.String,
      Name: Schema.String,
    }),
  ),
  Bcc: Schema.String,
  Cc: Schema.String,
  From: Schema.String,
  Headers: Schema.Array(Schema.Struct({ Name: Schema.String, Value: Schema.String })),
  HtmlBody: Schema.String,
  MessageStream: Schema.String,
  Metadata: Schema.Record(Schema.String, Schema.String),
  ReplyTo: Schema.String,
  Subject: Schema.String,
  Tag: Schema.String,
  TextBody: Schema.String,
  To: Schema.String,
  TrackLinks: Schema.String,
  TrackOpens: Schema.Boolean,
});

const singleAttempt = {
  deadline: Duration.seconds(5),
  initialDelay: Duration.millis(100),
  maxAttempts: 1,
};

describe("Postmark local HTTP wire", () => {
  it.effect(
    "preflights without credentials and preserves local key refusal rather than granting submit authority",
    () =>
      Effect.gen(function* inspectPostmarkIntent() {
        const preview = yield* preflightPostmarkEmail({
          ...message,
          metadata: { category: "private-preflight-value" },
        });

        assert.strictEqual(preview.metadata?.category, "private-preflight-value");
        assert(Object.isFrozen(preview.metadata));

        const result = yield* preflightPostmarkEmail(preview, {
          idempotencyKey: "private-key",
        }).pipe(Effect.result);

        assert(Result.isFailure(result));
        assert(result.failure instanceof EmailRejected);
        assert.strictEqual(result.failure.reason, "unsupported-idempotency");
      }),
  );
  it.live.each([
    { expected: "outbound", stream: undefined },
    { expected: "notifications", stream: "notifications" },
  ])(
    "submits complete common fields to $expected without enabling tracking",
    ({ stream, expected }) =>
      Effect.gen(function* observePostmarkSubmission() {
        const fixture = yield* startEmailHttpFixture({
          body: '{"ErrorCode":0,"MessageID":"provider-message-1","To":"private-echo@example.test","Message":"OK"}',
          status: 200,
        });

        const configuration =
          stream === undefined
            ? { serverToken: Redacted.make("fictional-server-token") }
            : { messageStream: stream, serverToken: Redacted.make("fictional-server-token") };

        const receipt = yield* Effect.gen(function* sendWireMessage() {
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

          return yield* (yield* Email).send({
            ...message,
            attachments: [binary, text],
            bcc: "hidden@example.test",
            cc: { address: "copy@example.test", name: "Fictional Copy" },
            from: { address: message.from, name: 'Fictional, "Team"' },
            headers: [
              { name: "X-Workflow", value: "first" },
              { name: "x-workflow", value: "second" },
            ],
            metadata: { workflow: "synthetic" },
            replyTo: ["reply@example.test", "another-reply@example.test"],
            tags: [{ name: "workflow", value: "synthetic" }],
          });
        }).pipe(
          Effect.provide(
            postmarkEmailLayer(configuration).pipe(Layer.provide(clientLayer(fixture.url))),
          ),
        );

        const received = yield* Queue.take(fixture.received);

        const payload = yield* Schema.decodeEffect(Schema.fromJsonString(ReceivedPostmarkEmail))(
          received.body,
        );

        assert.strictEqual(received.method, "POST");
        assert.strictEqual(received.path, "/email");
        assert.strictEqual(received.serverToken, "fictional-server-token");
        assert.strictEqual(received.authorization, "");
        assert.strictEqual(received.idempotencyKey, "");
        assert.strictEqual(payload.From, '"Fictional, \\"Team\\"" <sender@example.test>');
        assert.strictEqual(payload.Subject, message.subject);
        assert.strictEqual(payload.To, "recipient@example.test, other@example.test");
        assert.strictEqual(payload.Cc, '"Fictional Copy" <copy@example.test>');
        assert.strictEqual(payload.Bcc, "hidden@example.test");
        assert.strictEqual(payload.ReplyTo, "reply@example.test, another-reply@example.test");
        assert.strictEqual(payload.TextBody, message.body.text);
        assert.strictEqual(payload.HtmlBody, message.body.html);
        assert.strictEqual(payload.MessageStream, expected);
        assert.strictEqual(payload.TrackLinks, "None");
        assert.strictEqual(payload.TrackOpens, false);
        assert.deepStrictEqual(payload.Headers, [
          { Name: "X-Workflow", Value: "first" },
          { Name: "x-workflow", Value: "second" },
        ]);
        assert.strictEqual(payload.Metadata.workflow, "synthetic");
        assert.strictEqual(payload.Tag, "workflow:synthetic");
        const [binary, text] = payload.Attachments;
        assert.isDefined(binary);
        assert.isDefined(text);
        assert.strictEqual(payload.Attachments.length, 2);
        assert.deepStrictEqual([...Buffer.from(binary.Content, "base64")], [0, 255, 128, 10]);
        assert.strictEqual(binary.Name, "sample.dat");
        assert.strictEqual(binary.ContentType, "application/octet-stream");
        assert.strictEqual(Buffer.from(text.Content, "base64").toString("utf-8"), "Fictional café");
        assert.strictEqual(text.Name, "sample.txt");
        assert.strictEqual(text.ContentType, "text/plain");
        assert.strictEqual(text.ContentID, "cid:inline-text");
        assert.strictEqual(binary.ContentID, undefined);
        assert(EmailReceiptSchema.guards.Accepted(receipt));
        assert.strictEqual(receipt.provider, "postmark");
        assert.strictEqual(String(receipt.messageId), "provider-message-1");
        assert.notInclude(JSON.stringify(receipt), "private-");
      }),
  );

  it.live.each([
    {
      body: '{"MessageID":"not-acknowledged"}',
      code: undefined,
      reason: "invalid-response",
      status: 200,
      uncertain: true,
    },
    {
      body: '{"ErrorCode":0}',
      code: undefined,
      reason: "invalid-response",
      status: 200,
      uncertain: true,
    },
    {
      body: '{"ErrorCode":403,"MessageID":"misleading-id","Message":"private-invalid-fields"}',
      code: 403,
      reason: "invalid-message",
      status: 200,
      uncertain: false,
    },
    {
      body: '{"ErrorCode":406,"Message":"private-inactive-recipient"}',
      code: 406,
      reason: "rejected",
      status: 422,
      uncertain: false,
    },
    {
      body: '{"ErrorCode":300,"Message":"private-address"}',
      code: 300,
      reason: "invalid-message",
      status: 422,
      uncertain: false,
    },
    {
      body: '{"ErrorCode":9999,"Message":"private-new-code"}',
      code: 9999,
      reason: "invalid-response",
      status: 422,
      uncertain: true,
    },
    {
      body: '{"ErrorCode":0,"MessageID":"contradictory-acknowledgement"}',
      code: undefined,
      reason: "unexpected-status",
      status: 422,
      uncertain: true,
    },
    {
      body: '{"ErrorCode":101,"Message":"private-server-failure"}',
      code: 101,
      reason: "server-error",
      status: 200,
      uncertain: true,
    },
    {
      body: '{"ErrorCode":10,"Message":"private-token"}',
      code: undefined,
      reason: "authentication",
      status: 401,
      uncertain: false,
    },
    {
      body: '{"ErrorCode":101,"Message":"private-server"}',
      code: undefined,
      reason: "server-error",
      status: 503,
      uncertain: true,
    },
    {
      body: '{"Message":"private-rate-limit"}',
      code: undefined,
      reason: "rate-limited",
      retryAfter: "2",
      status: 429,
      uncertain: false,
    },
    {
      body: '{"ErrorCode":0,"MessageID":"unsupported-status"}',
      code: undefined,
      reason: "unexpected-status",
      status: 202,
      uncertain: true,
    },
  ])(
    "classifies $status/$reason without leaking bodies or replaying ambiguous submissions",
    (scenario) =>
      Effect.gen(function* classifyPostmarkOutcome() {
        const fixture = yield* startEmailHttpFixture(scenario);

        const outcome = yield* Effect.gen(function* sendClassifiedMessage() {
          return yield* (yield* Email).send(message);
        }).pipe(
          Effect.provide(
            postmarkEmailLayer(
              { serverToken: Redacted.make("fictional-token") },
              scenario.reason === "rate-limited" ? singleAttempt : undefined,
            ).pipe(Layer.provide(clientLayer(fixture.url))),
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
        assert.strictEqual(outcome.failure.providerCode, scenario.code);
        assert.strictEqual(outcome.failure.status, scenario.status);

        if (Schema.is(EmailRejected)(outcome.failure) && scenario.reason === "rate-limited") {
          assert.strictEqual(outcome.failure.retryAfterMillis, 2000);
        }

        assert.notInclude(JSON.stringify(outcome.failure), "private-");
        assert.strictEqual(yield* Queue.size(fixture.received), 1);
      }),
  );

  it.live(
    "rejects idempotency keys before HTTP instead of silently discarding replay authority",
    () =>
      Effect.gen(function* rejectUnsupportedKey() {
        const fixture = yield* startEmailHttpFixture({
          body: '{"ErrorCode":0,"MessageID":"not-used"}',
          status: 200,
        });

        const error = yield* Effect.gen(function* sendKeyedMessage() {
          return yield* (yield* Email).send(message, { idempotencyKey: "private-key" });
        }).pipe(
          Effect.provide(
            postmarkEmailLayer({ serverToken: Redacted.make("fictional-token") }).pipe(
              Layer.provide(clientLayer(fixture.url)),
            ),
          ),
          Effect.flip,
        );

        assert(Schema.is(EmailRejected)(error));
        assert.strictEqual(error.reason, "unsupported-idempotency");
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
        assert.notInclude(JSON.stringify(error), "private-");
      }),
  );

  it.live.each([
    {
      label: "unsafe credential bytes",
      options: { serverToken: Redacted.make("private token with spaces") },
      path: "serverToken",
    },
    {
      label: "validation-only test token",
      options: { serverToken: Redacted.make("postmark_api_test") },
      path: "serverToken",
    },
    {
      label: "invalid stream identifier",
      options: {
        messageStream: "private-invalid-stream!",
        serverToken: Redacted.make("fictional-token"),
      },
      path: "messageStream",
    },
  ])("rejects $label at acquisition without HTTP", ({ options, path }) =>
    Effect.gen(function* rejectPostmarkConfiguration() {
      const fixture = yield* startEmailHttpFixture({ body: "not-used", status: 200 });

      const error = yield* Effect.service(Email).pipe(
        Effect.provide(postmarkEmailLayer(options).pipe(Layer.provide(clientLayer(fixture.url)))),
        Effect.flip,
      );

      assert(Schema.is(EmailConfigurationError)(error));
      assert.strictEqual(error.issues[0]?.path, path);
      assert.notInclude(JSON.stringify(error), "private-");
      assert.notInclude(JSON.stringify(error), "postmark_api_test");
      assert.strictEqual(yield* Queue.size(fixture.received), 0);
    }),
  );
});
