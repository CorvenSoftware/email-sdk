import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Fiber, Layer, Queue, Redacted, Result, Schema, Tracer } from "effect";
import { TestClock } from "effect/testing";
import { emailFixtureClientLayer, startEmailHttpFixture } from "../test/email-http-fixture.js";
import type { EmailHttpFixture } from "../test/email-http-fixture.js";
import { startEmailTraceFixture } from "../test/email-tracing-fixture.js";
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
import { graphEmailLayer, graphSenderLayer } from "./graph-email-sender.js";
import type { GraphEmailOptions } from "./graph-email-sender.js";
import { resendEmailLayer } from "./resend-email-sender.js";

const message = {
  body: { text: "Synthetic café {{literal}}" },
  from: { address: "sender@example.test", name: 'Fictional "Café"' },
  subject: "Synthetic Graph notification",
  to: ["recipient@example.test"],
} as const;

const options = {
  accessToken: Redacted.make("fictional-access-token"),
  mailFlow: "ProviderUnmodified",
  mailboxAddress: "sender@example.test",
  mailboxId: "33333333-3333-4333-8333-333333333333",
  senderIdentity: "OwnerOrSendAs",
  sentItems: "DoNotSave",
} as const;

const policy = {
  deadline: Duration.seconds(5),
  initialDelay: Duration.millis(100),
  maxAttempts: 3,
};

const fixtureGraphLayer = (
  fixture: EmailHttpFixture,
  sentItems: GraphEmailOptions["sentItems"] = "DoNotSave",
) =>
  graphEmailLayer({ ...options, sentItems }, policy).pipe(
    Layer.provide(emailFixtureClientLayer(fixture.url, "https://graph.microsoft.com")),
  );

const fixtureGraphRoute = (primary: EmailHttpFixture, backup: EmailHttpFixture) =>
  emailRouterLayer(
    [
      { layer: fixtureGraphLayer(primary), name: "primary" },
      {
        layer: resendEmailLayer({ apiKey: Redacted.make("fictional-backup-key") }, policy).pipe(
          Layer.provide(emailFixtureClientLayer(backup.url, "https://api.resend.com")),
        ),
        name: "backup",
      },
    ],
    { fallbacks: ["backup"], primary: "primary" },
  );

const GraphWireRecipient = Schema.Struct({
  emailAddress: Schema.Struct({ address: Schema.String, name: Schema.optionalKey(Schema.String) }),
});

const GraphWire = Schema.Struct({
  message: Schema.Struct({
    attachments: Schema.Array(
      Schema.Struct({
        "@odata.type": Schema.String,
        contentBytes: Schema.String,
        contentId: Schema.optionalKey(Schema.String),
        contentType: Schema.String,
        isInline: Schema.Boolean,
        name: Schema.String,
      }),
    ),
    bccRecipients: Schema.Array(GraphWireRecipient),
    body: Schema.Struct({ content: Schema.String, contentType: Schema.String }),
    ccRecipients: Schema.Array(GraphWireRecipient),
    from: GraphWireRecipient,
    internetMessageHeaders: Schema.Array(
      Schema.Struct({ name: Schema.String, value: Schema.String }),
    ),
    isDeliveryReceiptRequested: Schema.Boolean,
    isReadReceiptRequested: Schema.Boolean,
    replyTo: Schema.Array(GraphWireRecipient),
    sender: Schema.optionalKey(Schema.Never),
    subject: Schema.String,
    toRecipients: Schema.Array(GraphWireRecipient),
  }),
  saveToSentItems: Schema.Boolean,
});

const GraphBodyWire = Schema.Struct({
  message: Schema.Struct({
    body: Schema.Struct({ content: Schema.String, contentType: Schema.String }),
    from: GraphWireRecipient,
    subject: Schema.String,
  }),
  saveToSentItems: Schema.optionalKey(Schema.Boolean),
});

describe("Microsoft Graph constrained mailbox single sends", () => {
  it.live(
    "preserves mailbox-bound identity, visible groups, replies, literal HTML and explicit MIME/CID bytes",
    () =>
      Effect.gen(function* inspectGraphWire() {
        const fixture = yield* startEmailHttpFixture({ body: "", status: 202 });

        const input = {
          ...message,
          attachments: [
            { contentBase64: "AP+ACg==", contentType: "application/pdf", filename: "sample.pdf" },
            {
              contentBase64: "AQID",
              contentId: "logo",
              contentType: "image/png",
              filename: "image.png",
            },
            {
              contentBase64: "BAUG",
              contentId: "second",
              contentType: "image/jpeg",
              disposition: "inline",
              filename: "second.jpg",
            },
          ],
          bcc: { address: "hidden@example.test", name: "Hidden Fictional" },
          body: { html: '<p>Literal {{name}} café <img src="cid:logo"></p>' },
          cc: "copy@example.test",
          headers: [
            { name: "X-Workflow", value: "synthetic" },
            { name: "X-Second", value: "a" },
            { name: "X-Third", value: "b" },
            { name: "X-Fourth", value: "c" },
            { name: "X-Fifth", value: "d" },
          ],
          replyTo: [{ address: "reply@example.test", name: 'Reply "Café"' }, "other@example.test"],
          to: [{ address: "first@example.test", name: "First Fictional" }, "second@example.test"],
        } as const;

        const receipt = yield* Effect.gen(function* submitRichGraphMessage() {
          return yield* (yield* Email).send(input);
        }).pipe(Effect.provide(fixtureGraphLayer(fixture)));

        assert(EmailReceiptSchema.guards.Accepted(receipt));
        assert.isUndefined(receipt.messageId);
        Reflect.set(receipt, "provider", "private-mutated-provider");
        assert.strictEqual(receipt.provider, "graph");
        assert.isTrue(Object.isFrozen(receipt));
        const sent = yield* Queue.take(fixture.received);
        assert.strictEqual(sent.method, "POST");
        assert.strictEqual(sent.path, `/v1.0/users/${options.mailboxId}/sendMail`);
        assert.strictEqual(sent.authorization, "Bearer fictional-access-token");
        assert.strictEqual(sent.idempotencyKey, "");
        assert.include(sent.contentType, "application/json");
        const wire = yield* Schema.decodeEffect(Schema.fromJsonString(GraphWire))(sent.body);
        assert.deepStrictEqual(wire.message.from.emailAddress, input.from);
        assert.deepStrictEqual(
          wire.message.toRecipients.map(({ emailAddress }) => emailAddress),
          [
            { address: "first@example.test", name: "First Fictional" },
            { address: "second@example.test" },
          ],
        );
        assert.deepStrictEqual(
          wire.message.ccRecipients.map(({ emailAddress }) => emailAddress),
          [{ address: "copy@example.test" }],
        );
        assert.deepStrictEqual(
          wire.message.bccRecipients.map(({ emailAddress }) => emailAddress),
          [{ address: "hidden@example.test", name: "Hidden Fictional" }],
        );
        assert.deepStrictEqual(
          wire.message.replyTo.map(({ emailAddress }) => emailAddress),
          [
            { address: "reply@example.test", name: 'Reply "Café"' },
            { address: "other@example.test" },
          ],
        );
        assert.deepStrictEqual(wire.message.body, {
          content: input.body.html,
          contentType: "HTML",
        });
        assert.deepStrictEqual(wire.message.internetMessageHeaders, input.headers);
        assert.strictEqual(wire.message.subject, input.subject);
        assert.isFalse(wire.saveToSentItems);
        assert.isFalse(wire.message.isReadReceiptRequested);
        assert.isFalse(wire.message.isDeliveryReceiptRequested);
        assert.strictEqual(wire.message.attachments.length, 3);
        const [ordinary, inline, explicitInline] = wire.message.attachments;
        assert.isDefined(ordinary);
        assert.isDefined(inline);
        assert.isDefined(explicitInline);
        assert.strictEqual(ordinary["@odata.type"], "#microsoft.graph.fileAttachment");
        assert.strictEqual(ordinary.name, "sample.pdf");
        assert.strictEqual(ordinary.contentType, "application/pdf");
        assert.isFalse(ordinary.isInline);
        assert.isUndefined(ordinary.contentId);
        assert.deepStrictEqual(
          [...Buffer.from(ordinary.contentBytes, "base64")],
          [0, 255, 128, 10],
        );
        assert.strictEqual(inline.contentId, "logo");
        assert.strictEqual(inline.name, "image.png");
        assert.strictEqual(inline.contentType, "image/png");
        assert.isTrue(inline.isInline);
        assert.deepStrictEqual([...Buffer.from(inline.contentBytes, "base64")], [1, 2, 3]);
        assert.strictEqual(explicitInline.contentId, "second");
        assert.isTrue(explicitInline.isInline);
        assert.deepStrictEqual([...Buffer.from(explicitInline.contentBytes, "base64")], [4, 5, 6]);
      }),
  );

  it.effect.each(["Text", "HTML"] as const)(
    "preserves literal Unicode and template syntax in the %s body and display name",
    (kind) =>
      Effect.gen(function* preserveGraphLiteralBody() {
        const fixture = yield* startEmailHttpFixture({ body: "", status: 202 });
        const content = '界😀é"\\ {{name}} %recipient.name% *|UNSUB|*';
        yield* Effect.gen(function* submitGraphLiteralBody() {
          return yield* (yield* Email).send({
            ...message,
            body: kind === "HTML" ? { html: content } : { text: content },
            from: { address: message.from.address, name: content },
            subject: content,
          });
        }).pipe(Effect.provide(fixtureGraphLayer(fixture, "Save")));
        const sent = yield* Queue.take(fixture.received);
        const wire = yield* Schema.decodeEffect(Schema.fromJsonString(GraphBodyWire))(sent.body);
        assert.deepStrictEqual(wire.message.body, { content, contentType: kind });
        assert.strictEqual(wire.message.from.emailAddress.name, content);
        assert.strictEqual(wire.message.subject, content);
        assert.isUndefined(wire.saveToSentItems);
      }),
  );

  it.live.each([
    "",
    "not-json-private-details",
    JSON.stringify({ delivered: true, id: "private-resource-id" }),
    "private-".repeat(20_000),
  ])(
    "keeps documented 202 terminal without reading bodies or inventing correlation/delivery (case %#)",
    (body) =>
      Effect.gen(function* settleGraphAcknowledgement() {
        const primary = yield* startEmailHttpFixture({
          body,
          messageId: "private-header-id",
          status: 202,
        });

        const backup = yield* startEmailHttpFixture({ body: '{"id":"backup-id"}', status: 200 });

        const receipt = yield* Effect.gen(function* sendGraphRoute() {
          return yield* (yield* (yield* EmailRouter).select()).send(message);
        }).pipe(Effect.provide(fixtureGraphRoute(primary, backup)));

        assert(EmailReceiptSchema.guards.Accepted(receipt));
        assert.isUndefined(receipt.messageId);
        assert.strictEqual(receipt.route, "primary");
        assert.isTrue(Object.isFrozen(receipt));
        assert.notInclude(JSON.stringify(receipt), "private");
        assert.strictEqual(yield* Queue.size(primary.received), 1);
        assert.strictEqual(yield* Queue.size(backup.received), 0);
      }),
  );

  it.live.each([200, 201, 204, 400, 401, 404, 409, 413, 422, 500, 503])(
    "does not replay or fall back from unreviewed HTTP %i",
    (status) =>
      Effect.gen(function* preserveGraphUncertainty() {
        const primary = yield* startEmailHttpFixture({
          body: '{"error":{"code":"private-code","message":"private-reason"},"id":"private-id"}',
          retryAfter: "0",
          status,
        });

        const backup = yield* startEmailHttpFixture({ body: '{"id":"backup-id"}', status: 200 });

        const result = yield* Effect.gen(function* sendUncertainGraphRoute() {
          return yield* (yield* (yield* EmailRouter).select()).send(message);
        }).pipe(Effect.provide(fixtureGraphRoute(primary, backup)), Effect.result);

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

  it.live.each(["ErrorSendAsDenied", "ErrorAccessDenied"] as const)(
    "uses reviewed whole-request %s refusal for safe fallback without retaining reasons",
    (code) =>
      Effect.gen(function* routeGraphDefiniteRefusal() {
        const primary = yield* startEmailHttpFixture({
          body: JSON.stringify({
            error: {
              code,
              innerError: { date: "private-date", "request-id": "private-request-id" },
              message: "private-provider-reason",
            },
          }),
          status: 403,
        });

        const backup = yield* startEmailHttpFixture({ body: '{"id":"backup-id"}', status: 200 });

        const receipt = yield* Effect.gen(function* sendRefusedGraphRoute() {
          return yield* (yield* (yield* EmailRouter).select()).send(message);
        }).pipe(Effect.provide(fixtureGraphRoute(primary, backup)));

        assert.strictEqual(receipt.route, "backup");
        assert.strictEqual(yield* Queue.size(primary.received), 1);
        assert.strictEqual(yield* Queue.size(backup.received), 1);
      }),
  );

  it.live.each([
    { body: "not-json-private", status: 403 },
    {
      body: JSON.stringify({ error: { code: "TooManyRequests", message: "private" } }),
      status: 403,
    },
    { body: JSON.stringify({ error: { code: "ErrorSendAsDenied" } }), status: 429 },
    {
      body: JSON.stringify({
        error: { code: "ErrorAccessDenied", details: [{ code: "private-partial" }] },
      }),
      status: 403,
    },
    {
      body: JSON.stringify({
        error: { code: "TooManyRequests", innerError: { code: "private-specific" } },
      }),
      status: 429,
    },
    {
      body: JSON.stringify({
        error: { code: "TooManyRequests", innererror: { code: "429", status: "403" } },
      }),
      status: 429,
    },
    {
      body: JSON.stringify({
        error: {
          code: "TooManyRequests",
          innerError: { code: "429", innerError: { code: "private-deep" } },
        },
      }),
      status: 429,
    },
    {
      body: JSON.stringify({ error: { code: "TooManyRequests" }, id: "private-accepted" }),
      status: 429,
    },
    {
      body: JSON.stringify({
        error: { code: "TooManyRequests", message: "private-".repeat(20_000) },
      }),
      status: 429,
    },
    { body: JSON.stringify({ error: { code: "MailboxQuota" } }), status: 429 },
  ])(
    "requires coherent bounded whole-request refusal proof, not human or partial errors (case %#)",
    ({ body, status }) =>
      Effect.gen(function* refuseUnprovedGraphFailure() {
        const primary = yield* startEmailHttpFixture({ body, retryAfter: "0", status });
        const backup = yield* startEmailHttpFixture({ body: '{"id":"backup-id"}', status: 200 });

        const result = yield* Effect.gen(function* sendGraphUnprovedFailure() {
          return yield* (yield* (yield* EmailRouter).select()).send(message);
        }).pipe(Effect.provide(fixtureGraphRoute(primary, backup)), Effect.result);

        assert(Result.isFailure(result));
        assert(result.failure instanceof EmailDeliveryUnknown);
        assert.strictEqual(result.failure.reason, "invalid-response");
        assert.notInclude(JSON.stringify(result.failure), "private");
        assert.strictEqual(yield* Queue.size(primary.received), 1);
        assert.strictEqual(yield* Queue.size(backup.received), 0);
      }),
  );

  it.effect.each(["innerError", "innererror"] as const)(
    "retries proven throttling with %s only after its minimum delay and unchanged owned intent",
    (innerKey) =>
      Effect.gen(function* retryGraphRefusal() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify({
            error: {
              code: "TooManyRequests",
              details: [],
              [innerKey]: { code: "429", status: "429" },
            },
          }),
          next: { body: "", status: 202 },
          retryAfter: "2",
          status: 429,
        });

        const input: Omit<typeof message, "subject"> & { subject: string } = { ...message };

        const fiber = yield* Effect.gen(function* sendThrottledGraphMessage() {
          return yield* (yield* Email).send(input);
        }).pipe(Effect.provide(fixtureGraphLayer(fixture)), Effect.forkScoped);

        const first = yield* Queue.take(fixture.received);
        input.subject = "private-mutated";
        yield* TestClock.adjust(1000);
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
        yield* TestClock.adjust(2000);
        assert(EmailReceiptSchema.guards.Accepted(yield* Fiber.join(fiber)));
        const second = yield* Queue.take(fixture.received);
        assert.strictEqual(second.body, first.body);
        assert.strictEqual(second.authorization, first.authorization);
        assert.strictEqual(second.idempotencyKey, "");
        assert.notInclude(second.body, "private-mutated");
      }),
  );

  it.live.each([
    { ...message, from: "other@example.test" },
    { ...message, body: { html: "<p>selected HTML</p>", text: "selected text" } },
    { ...message, cc: "RECIPIENT@example.test" },
    { ...message, replyTo: ["reply@example.test", "REPLY@example.test"] },
    {
      ...message,
      headers: [
        { name: "X-Workflow", value: "a" },
        { name: "x-workflow", value: "b" },
      ],
    },
    { ...message, headers: [{ name: "List-Unsubscribe", value: "<https://fictional.test>" }] },
    { ...message, headers: [{ name: "X-MS-Exchange-Organization-BypassClutter", value: "true" }] },
    { ...message, headers: [{ name: "X-Auto-Response-Suppress", value: "All" }] },
    {
      ...message,
      headers: [
        { name: "X-Custom-1", value: "private" },
        ...[2, 3, 4, 5, 6].map((index) => ({ name: `X-Custom-${index}`, value: "private" })),
      ],
    },
    { ...message, metadata: { workflow: "private" } },
    { ...message, tags: [{ name: "workflow", value: "private" }] },
    { ...message, sendAt: "2026-10-14T12:30:00Z" },
    {
      ...message,
      attachments: [
        { contentBase64: "AQID", contentType: "ProviderSelected", filename: "sample.txt" },
      ],
    },
  ] as const)(
    "rejects incompatible intent across all candidates before either HTTP submission (case %#)",
    (input) =>
      Effect.gen(function* preflightGraphIntent() {
        const primary = yield* startEmailHttpFixture({ body: "", status: 202 });
        const backup = yield* startEmailHttpFixture({ body: '{"id":"backup-id"}', status: 200 });

        const results = yield* Effect.gen(function* validateGraphRoute() {
          const email = yield* (yield* EmailRouter).select();

          return [
            yield* email.validate(input).pipe(Effect.asVoid, Effect.result),
            yield* email.send(input).pipe(Effect.asVoid, Effect.result),
          ];
        }).pipe(Effect.provide(fixtureGraphRoute(primary, backup)));

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
    "bounds actual UTF-8 request JSON including attachments without truncating selected content",
    () =>
      Effect.gen(function* boundGraphRequest() {
        const fixture = yield* startEmailHttpFixture({ body: "", status: 202 });
        yield* Effect.gen(function* sendGraphBudgetBoundary() {
          const email = yield* Email;

          const baseline = {
            ...message,
            attachments: [
              {
                contentBase64: Buffer.alloc(1_048_576).toString("base64"),
                contentType: "application/pdf",
                filename: "first.pdf",
              },
              {
                contentBase64: Buffer.alloc(1_048_576).toString("base64"),
                contentType: "application/pdf",
                filename: "second.pdf",
              },
            ],
            body: { text: "x" },
          } as const;

          yield* email.send(baseline);
          const first = yield* Queue.take(fixture.received);
          const available = 3_000_000 - Buffer.byteLength(first.body, "utf-8") + 1;
          const text = "界".repeat(Math.floor(available / 3)) + "x".repeat(available % 3);
          yield* email.send({ ...baseline, body: { text } });
          const sent = yield* Queue.take(fixture.received);
          assert.strictEqual(Buffer.byteLength(sent.body, "utf-8"), 3_000_000);
          const wire = yield* Schema.decodeEffect(Schema.fromJsonString(GraphBodyWire))(sent.body);
          assert.strictEqual(wire.message.body.content, text);

          const result = yield* email
            .send({ ...baseline, body: { text: `${text}x` } })
            .pipe(Effect.result);

          assert(Result.isFailure(result));
          assert(result.failure instanceof EmailInvalidMessage);
          assert.strictEqual(yield* Queue.size(fixture.received), 0);
        }).pipe(Effect.provide(fixtureGraphLayer(fixture)));
      }),
  );

  it.live(
    "defends keys and incompatible backup mailbox identity at ordinary, routed and direct entrypoints",
    () =>
      Effect.gen(function* defendGraphSubmissionBoundaries() {
        const primary = yield* startEmailHttpFixture({ body: "", status: 202 });
        const backup = yield* startEmailHttpFixture({ body: '{"id":"backup-id"}', status: 200 });

        const ordinary = yield* Effect.gen(function* sendGraphKey() {
          return yield* (yield* Email).send(message, { idempotencyKey: "private-key" });
        }).pipe(Effect.provide(fixtureGraphLayer(primary)), Effect.result);

        const routed = yield* Effect.gen(function* sendGraphRouteKey() {
          return yield* (yield* (yield* EmailRouter).select()).send(message, {
            idempotencyKey: "private-key",
          });
        }).pipe(Effect.provide(fixtureGraphRoute(primary, backup)), Effect.result);

        const direct = yield* Effect.gen(function* sendDirectGraphKey() {
          return yield* (yield* EmailSender).submit({
            idempotencyKey: EmailIdempotencyKeySchema.make("private-key"),
            message: yield* parseEmailMessage(message),
          });
        }).pipe(
          Effect.provide(
            graphSenderLayer(options).pipe(
              Layer.provide(emailFixtureClientLayer(primary.url, "https://graph.microsoft.com")),
            ),
          ),
          Effect.result,
        );

        for (const result of [ordinary, routed, direct]) {
          assert(Result.isFailure(result));
          assert(result.failure instanceof EmailRejected);
          assert.strictEqual(result.failure.reason, "unsupported-idempotency");
          assert.notInclude(JSON.stringify(result.failure), "private-key");
        }

        const incompatible = yield* Effect.gen(function* preflightGraphBackup() {
          const router = yield* EmailRouter;
          const email = yield* router.select();

          return [
            yield* email
              .send(message, { idempotencyKey: "private-key" })
              .pipe(Effect.asVoid, Effect.result),
            yield* email
              .send({ ...message, from: "foreign@example.test" })
              .pipe(Effect.asVoid, Effect.result),
          ] as const;
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
                { layer: fixtureGraphLayer(backup), name: "backup" },
              ],
              { fallbacks: ["backup"], primary: "primary" },
            ),
          ),
        );

        assert(
          Result.isFailure(incompatible[0]) && incompatible[0].failure instanceof EmailRejected,
        );
        assert(
          Result.isFailure(incompatible[1]) &&
            incompatible[1].failure instanceof EmailInvalidMessage,
        );

        const invalidDirect = yield* Effect.gen(function* defendDirectGraphFrom() {
          return yield* (yield* EmailSender).submit({
            message: yield* parseEmailMessage({ ...message, from: "foreign@example.test" }),
          });
        }).pipe(
          Effect.provide(
            graphSenderLayer(options).pipe(
              Layer.provide(emailFixtureClientLayer(primary.url, "https://graph.microsoft.com")),
            ),
          ),
          Effect.result,
        );

        assert(Result.isFailure(invalidDirect) && invalidDirect.failure instanceof EmailRejected);
        assert.strictEqual(invalidDirect.failure.reason, "invalid-message");
        assert.strictEqual(yield* Queue.size(primary.received), 0);
        assert.strictEqual(yield* Queue.size(backup.received), 0);
      }),
  );

  it.live.each([
    { field: "accessToken", value: "private-unwrapped-token" },
    { field: "accessToken", value: Redacted.make("") },
    { field: "accessToken", value: Redacted.make("private token") },
    { field: "accessToken", value: Redacted.make("private\r\ntoken") },
    { field: "mailboxId", value: "private/path?query" },
    { field: "mailboxAddress", value: "Private <sender@example.test>" },
    { field: "senderIdentity", value: "SendOnBehalf" },
    { field: "mailFlow", value: "AllowRewriting" },
    { field: "sentItems", value: "DiscardGuaranteed" },
    ...[
      "accessToken",
      "mailboxId",
      "mailboxAddress",
      "senderIdentity",
      "mailFlow",
      "sentItems",
    ].map((field) => ({ field, value: undefined })),
    { field: "baseUrl", value: "https://private.test" },
  ])(
    "requires explicit safe credentials, mailbox identity and remote-state choices (case %#)",
    ({ field, value }) =>
      Effect.gen(function* refuseGraphConfiguration() {
        const fixture = yield* startEmailHttpFixture({ body: "", status: 202 });
        const configuration = { ...options };
        Reflect.set(configuration, field, value);

        const result = yield* Effect.service(Email).pipe(
          Effect.provide(
            graphEmailLayer(configuration).pipe(
              Layer.provide(emailFixtureClientLayer(fixture.url, "https://graph.microsoft.com")),
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
    "owns acquired mailbox/token/sent-item choices and preserves casefold-bound caller identity",
    () =>
      Effect.gen(function* ownGraphConfiguration() {
        const fixture = yield* startEmailHttpFixture({ body: "", status: 202 });
        const configuration: GraphEmailOptions = { ...options };
        yield* Effect.gen(function* mutateGraphConfigurationAfterAcquisition() {
          const email = yield* Email;
          Reflect.set(configuration, "accessToken", Redacted.make("private-mutated-token"));
          Reflect.set(configuration, "mailboxId", "44444444-4444-4444-8444-444444444444");
          Reflect.set(configuration, "mailboxAddress", "foreign@example.test");
          Reflect.set(configuration, "sentItems", "Save");
          Reflect.set(configuration, "senderIdentity", "SendOnBehalf");
          Reflect.set(configuration, "mailFlow", "AllowRewriting");
          yield* email.send({
            ...message,
            from: { ...message.from, address: "SENDER@example.test" },
          });
        }).pipe(
          Effect.provide(
            graphEmailLayer(configuration, policy).pipe(
              Layer.provide(emailFixtureClientLayer(fixture.url, "https://graph.microsoft.com")),
            ),
          ),
        );
        const sent = yield* Queue.take(fixture.received);
        assert.strictEqual(sent.path, `/v1.0/users/${options.mailboxId}/sendMail`);
        assert.strictEqual(sent.authorization, "Bearer fictional-access-token");
        const wire = yield* Schema.decodeEffect(Schema.fromJsonString(GraphBodyWire))(sent.body);
        assert.strictEqual(wire.message.from.emailAddress.address, "SENDER@example.test");
        assert.isFalse(wire.saveToSentItems);
      }),
  );

  it.live(
    "keeps mailbox IDs, tokens and private provider reasons outside real NativeSpan exits",
    () =>
      Effect.gen(function* inspectGraphDiagnosticPrivacy() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify({
            error: {
              code: "ErrorSendAsDenied",
              innerError: { "request-id": "private-request" },
              message: "private-reason",
            },
          }),
          status: 403,
        });

        const trace = yield* startEmailTraceFixture();

        const result = yield* Effect.gen(function* sendPrivateGraphMessage() {
          return yield* (yield* Email).send(message);
        }).pipe(
          Effect.provide(fixtureGraphLayer(fixture)),
          Effect.provideService(Tracer.Tracer, trace.tracer),
          Effect.result,
        );

        assert(Result.isFailure(result) && result.failure instanceof EmailRejected);
        assert.strictEqual(result.failure.reason, "authentication");
        const diagnostics = yield* trace.diagnostics;
        assert.include(diagnostics, "Graph.submit");

        for (const privateValue of [
          options.mailboxId,
          options.mailboxAddress,
          "fictional-access-token",
          "private-reason",
          "private-request",
          message.body.text,
        ]) {
          assert.notInclude(diagnostics, privateValue);
          assert.notInclude(JSON.stringify(result.failure), privateValue);
        }
      }),
  );
});
