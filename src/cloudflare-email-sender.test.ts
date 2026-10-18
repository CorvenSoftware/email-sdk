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
  EmailInvalidMessage,
  EmailReceiptSchema,
  EmailRejected,
  EmailRouter,
  EmailSender,
  EmailIdempotencyKeySchema,
  emailRouterLayer,
  parseEmailMessage,
} from "./index.js";
import { cloudflareEmailLayer, cloudflareSenderLayer } from "./cloudflare-email-sender.js";
import type { CloudflareEmailOptions } from "./cloudflare-email-sender.js";
import { resendEmailLayer } from "./resend-email-sender.js";

const options = {
  accountId: "0123456789abcdef0123456789abcdef",
  apiToken: Redacted.make("fictional-cloudflare-token"),
  mailFlow: "ProviderUnmodified",
} as const;

const message = {
  body: { html: "<p>Literal café {{name}}</p>", text: "Literal café {{name}}" },
  from: { address: "sender@example.test", name: "Fictional Café" },
  subject: "Synthetic Cloudflare notification",
  to: "recipient@example.test",
} as const;

const policy = {
  deadline: Duration.seconds(5),
  initialDelay: Duration.millis(100),
  maxAttempts: 3,
};

const acknowledgement = {
  errors: [],
  messages: [],
  result: {
    delivered: [],
    message_id: "<fictional@example.test>",
    permanent_bounces: [],
    queued: [message.to],
  },
  success: true,
};

const problem = (code: number, machineMessage: string) => ({
  errors: [{ code, message: machineMessage }],
  messages: [],
  result: null,
  success: false,
});

const fixtureCloudflareLayer = (fixture: EmailHttpFixture) =>
  cloudflareEmailLayer(options, policy).pipe(
    Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.cloudflare.com")),
  );

const fixtureRoute = (primary: EmailHttpFixture, backup: EmailHttpFixture) =>
  emailRouterLayer(
    [
      { layer: fixtureCloudflareLayer(primary), name: "primary" },
      {
        layer: resendEmailLayer({ apiKey: Redacted.make("fictional-backup") }, policy).pipe(
          Layer.provide(emailFixtureClientLayer(backup.url, "https://api.resend.com")),
        ),
        name: "backup",
      },
    ],
    { fallbacks: ["backup"], primary: "primary" },
  );

const CloudflareWireMailbox = Schema.Union([
  Schema.String,
  Schema.Struct({ address: Schema.String, name: Schema.optionalKey(Schema.String) }),
]);

const CloudflareWire = Schema.Struct({
  attachments: Schema.Array(
    Schema.Struct({
      content: Schema.String,
      content_id: Schema.optionalKey(Schema.String),
      disposition: Schema.String,
      filename: Schema.String,
      type: Schema.String,
    }),
  ),
  bcc: Schema.Array(CloudflareWireMailbox),
  cc: Schema.Array(CloudflareWireMailbox),
  from: CloudflareWireMailbox,
  headers: Schema.Record(Schema.String, Schema.String),
  html: Schema.String,
  reply_to: CloudflareWireMailbox,
  subject: Schema.String,
  text: Schema.String,
  to: Schema.Array(CloudflareWireMailbox),
});

describe("Cloudflare constrained REST submission", () => {
  it.live(
    "preserves structured visible groups, literal alternatives, one reply and independently decoded MIME/CID bytes",
    () =>
      Effect.gen(function* inspectCloudflareWire() {
        const input = {
          ...message,
          attachments: [
            { contentBase64: "AP+ACg==", contentType: "application/pdf", filename: "report.pdf" },
            {
              contentBase64: "AQID",
              contentId: "independent-cid",
              contentType: "image/png",
              filename: "logo.png",
            },
          ],
          bcc: { address: "hidden@example.test", name: "Hidden" },
          cc: "copy@example.test",
          headers: [
            { name: "X-Workflow", value: "café" },
            { name: "In-Reply-To", value: "<parent@example.test>" },
          ],
          replyTo: { address: "reply@example.test", name: 'Fictional "Reply"' },
          to: ["recipient@example.test", { address: "second@example.test", name: 'Second "Café"' }],
        } as const;

        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify({
            ...acknowledgement,
            result: {
              ...acknowledgement.result,
              delivered: ["SECOND@example.test", "copy@example.test"],
              queued: [message.to, "hidden@example.test"],
            },
          }),
          status: 200,
        });

        const receipt = yield* Effect.gen(function* submitRichCloudflare() {
          return yield* (yield* Email).send(input);
        }).pipe(Effect.provide(fixtureCloudflareLayer(fixture)));

        assert(EmailReceiptSchema.guards.Accepted(receipt));
        assert.strictEqual(receipt.messageId, "<fictional@example.test>");
        assert.isTrue(Object.isFrozen(receipt));
        const sent = yield* Queue.take(fixture.received);
        assert.strictEqual(
          sent.path,
          `/client/v4/accounts/${options.accountId}/email/sending/send`,
        );
        assert.strictEqual(sent.method, "POST");
        assert.strictEqual(sent.authorization, "Bearer fictional-cloudflare-token");
        assert.strictEqual(sent.idempotencyKey, "");
        const wire = yield* Schema.decodeEffect(Schema.fromJsonString(CloudflareWire))(sent.body);
        assert.deepStrictEqual(wire.from, input.from);
        assert.deepStrictEqual(wire.to, input.to);
        assert.deepStrictEqual(wire.cc, [input.cc]);
        assert.deepStrictEqual(wire.bcc, [input.bcc]);
        assert.deepStrictEqual(wire.reply_to, input.replyTo);
        assert.strictEqual(wire.html, input.body.html);
        assert.strictEqual(wire.text, input.body.text);
        assert.strictEqual(wire.subject, input.subject);
        assert.strictEqual(wire.headers["X-Workflow"], "café");
        assert.strictEqual(wire.headers["In-Reply-To"], "<parent@example.test>");
        const [ordinary, inline] = wire.attachments;
        assert(ordinary !== undefined && inline !== undefined);
        assert.deepStrictEqual([...Buffer.from(ordinary.content, "base64")], [0, 255, 128, 10]);
        assert.strictEqual(ordinary.type, "application/pdf");
        assert.strictEqual(ordinary.disposition, "attachment");
        assert.strictEqual(ordinary.filename, "report.pdf");
        assert.isUndefined(ordinary.content_id);
        assert.deepStrictEqual([...Buffer.from(inline.content, "base64")], [1, 2, 3]);
        assert.strictEqual(inline.content_id, "independent-cid");
        assert.strictEqual(inline.filename, "logo.png");
        assert.strictEqual(inline.type, "image/png");
        assert.strictEqual(inline.disposition, "inline");
      }),
  );

  it.effect(
    "preserves Unicode, JSON escapes and template syntax literally in both bodies and subject",
    () =>
      Effect.gen(function* inspectLiteralCloudflareContent() {
        const literal = 'café 界😀 "quoted" \\ <>& {{name}} %recipient.name% *|UNSUB|*';

        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 200,
        });

        yield* Effect.gen(function* submitCloudflareLiteral() {
          return yield* (yield* Email).send({
            ...message,
            body: { html: `<p>{{literal}} ${literal}</p>`, text: literal },
            subject: literal,
          });
        }).pipe(Effect.provide(fixtureCloudflareLayer(fixture)));
        const sent = yield* Queue.take(fixture.received);

        const wire = yield* Schema.decodeEffect(
          Schema.fromJsonString(
            Schema.Struct({ html: Schema.String, subject: Schema.String, text: Schema.String }),
          ),
        )(sent.body);

        assert.strictEqual(wire.text, literal);
        assert.strictEqual(wire.subject, literal);
        assert.strictEqual(wire.html, `<p>{{literal}} ${literal}</p>`);
      }),
  );

  it.live.each([
    { delivered: [message.to], queued: [], suppressed_recipients: [] },
    { delivered: [], queued: [message.to], suppressed_recipients: [] },
    { delivered: [message.to.toUpperCase()], queued: [] },
  ])(
    "accepts only complete delivery-or-queue membership without requiring or inventing an ID (case %#)",
    (evidence) =>
      Effect.gen(function* inspectIdFreeCloudflareAcknowledgement() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify({
            ...acknowledgement,
            result: { permanent_bounces: [], ...evidence },
          }),
          status: 200,
        });

        const receipt = yield* Effect.gen(function* submitCloudflareWithoutId() {
          return yield* (yield* Email).send(message);
        }).pipe(Effect.provide(fixtureCloudflareLayer(fixture)));

        assert(EmailReceiptSchema.guards.Accepted(receipt));
        assert.isUndefined(receipt.messageId);
        assert.isTrue(Object.isFrozen(receipt));
        assert.strictEqual(yield* Queue.size(fixture.received), 1);
      }),
  );

  it.live.each([true, false])(
    "keeps partial suppression terminal with owned caller spelling/order and optional correlation (ID=%s)",
    (withId) =>
      Effect.gen(function* inspectCloudflarePartialSuppression() {
        const primary = yield* startEmailHttpFixture({
          body: JSON.stringify({
            ...acknowledgement,
            result: {
              delivered: ["FIRST@example.test"],
              message_id: withId ? "<fictional@example.test>" : undefined,
              permanent_bounces: [],
              queued: ["third@example.test"],
              suppressed_recipients: ["SECOND@example.test"],
            },
          }),
          status: 200,
        });

        const backup = yield* startEmailHttpFixture({
          body: JSON.stringify({ id: "backup-id" }),
          status: 200,
        });

        const receipt = yield* Effect.gen(function* routeCloudflareSuppression() {
          return yield* (yield* (yield* EmailRouter).select()).send({
            ...message,
            cc: "third@example.test",
            to: ["first@example.test", "second@example.test"],
          });
        }).pipe(Effect.provide(fixtureRoute(primary, backup)));

        assert(EmailReceiptSchema.guards.PartiallyAccepted(receipt));
        assert.deepStrictEqual(receipt.accepted.map(String), [
          "first@example.test",
          "third@example.test",
        ]);
        assert.deepStrictEqual(receipt.suppressed.map(String), ["second@example.test"]);
        assert.strictEqual(receipt.messageId, withId ? "<fictional@example.test>" : undefined);
        assert.isTrue(Object.isFrozen(receipt));
        assert.isTrue(Object.isFrozen(receipt.accepted));
        assert.isTrue(Object.isFrozen(receipt.suppressed));
        assert.strictEqual(receipt.route, "primary");
        assert.strictEqual(yield* Queue.size(primary.received), 1);
        assert.strictEqual(yield* Queue.size(backup.received), 0);
      }),
  );

  it.live("never routes around complete suppression", () =>
    Effect.gen(function* stopCloudflareSuppression() {
      const primary = yield* startEmailHttpFixture({
        body: JSON.stringify({
          ...acknowledgement,
          result: {
            delivered: [],
            permanent_bounces: [],
            queued: [],
            suppressed_recipients: ["RECIPIENT@example.test"],
          },
        }),
        status: 200,
      });

      const backup = yield* startEmailHttpFixture({
        body: JSON.stringify({ id: "backup-id" }),
        status: 200,
      });

      const receipt = yield* Effect.gen(function* routeCompleteCloudflareSuppression() {
        return yield* (yield* (yield* EmailRouter).select()).send(message);
      }).pipe(Effect.provide(fixtureRoute(primary, backup)));

      assert(EmailReceiptSchema.guards.Suppressed(receipt));
      assert.deepStrictEqual(receipt.suppressed.map(String), [message.to]);
      assert.isTrue(Object.isFrozen(receipt.suppressed));
      assert.strictEqual(yield* Queue.size(backup.received), 0);
    }),
  );

  it.live.each([
    { delivered: [], queued: [] },
    { delivered: [message.to], queued: [message.to] },
    { delivered: [message.to], queued: ["RECIPIENT@example.test"] },
    { delivered: ["foreign@example.test"], queued: [] },
    { delivered: [message.to], queued: [], suppressed_recipients: [message.to] },
    { delivered: [], permanent_bounces: [message.to], queued: [] },
    { delivered: [message.to], permanent_bounces: ["foreign@example.test"], queued: [] },
    { delivered: [message.to], message_id: "private invalid id", queued: [] },
    { delivered: [message.to], queued: [], suppressed_recipients: ["foreign@example.test"] },
    { accepted: true, delivered: [message.to], queued: [] },
  ])(
    "treats incomplete, overlapping, foreign, bounce or contradictory result evidence as uncertainty without fallback (case %#)",
    (evidence) =>
      Effect.gen(function* refuseCloudflareResultProof() {
        const primary = yield* startEmailHttpFixture({
          body: JSON.stringify({
            ...acknowledgement,
            result: { ...acknowledgement.result, ...evidence },
          }),
          status: 200,
        });

        const backup = yield* startEmailHttpFixture({
          body: JSON.stringify({ id: "backup-id" }),
          status: 200,
        });

        const result = yield* Effect.gen(function* routeInvalidCloudflareProof() {
          return yield* (yield* (yield* EmailRouter).select()).send(message);
        }).pipe(Effect.provide(fixtureRoute(primary, backup)), Effect.result);

        assert(Result.isFailure(result) && result.failure instanceof EmailDeliveryUnknown);
        assert.strictEqual(result.failure.reason, "invalid-response");
        assert.strictEqual(yield* Queue.size(primary.received), 1);
        assert.strictEqual(yield* Queue.size(backup.received), 0);
      }),
  );

  it.live.each([
    {
      code: 10_101,
      machineMessage: "email.sending.error.authentication.unauthorized",
      status: 401,
    },
    {
      code: 10_103,
      machineMessage: "email.sending.error.authentication.bad_token_type",
      status: 401,
    },
    { code: 10_102, machineMessage: "email.sending.error.authentication.forbidden", status: 403 },
    {
      code: 10_105,
      machineMessage: "email.sending.error.authentication.not_entitled",
      status: 403,
    },
    { code: 10_203, machineMessage: "email.sending.error.email.sending_disabled", status: 403 },
  ])(
    "allows fallback only for coherent reviewed whole-request refusal (case %#)",
    ({ code, machineMessage, status }) =>
      Effect.gen(function* routeCloudflareRefusal() {
        const primary = yield* startEmailHttpFixture({
          body: JSON.stringify(problem(code, machineMessage)),
          status,
        });

        const backup = yield* startEmailHttpFixture({
          body: JSON.stringify({ id: "backup-id" }),
          status: 200,
        });

        const receipt = yield* Effect.gen(function* fallbackCloudflareRefusal() {
          return yield* (yield* (yield* EmailRouter).select()).send(message);
        }).pipe(Effect.provide(fixtureRoute(primary, backup)));

        assert(EmailReceiptSchema.guards.Accepted(receipt));
        assert.strictEqual(receipt.route, "backup");
        assert.strictEqual(yield* Queue.size(primary.received), 1);
        assert.strictEqual(yield* Queue.size(backup.received), 1);
      }),
  );

  it.live.each([
    { body: problem(10_101, "email.sending.error.authentication.unauthorized"), status: 403 },
    { body: problem(10_004, "email.sending.error.authentication.unauthorized"), status: 429 },
    { body: problem(10_004, "private human reason"), status: 429 },
    {
      body: {
        ...problem(10_004, "email.sending.error.throttled"),
        result: { delivered: [message.to] },
      },
      status: 429,
    },
    {
      body: { ...problem(10_102, "email.sending.error.authentication.forbidden"), success: true },
      status: 403,
    },
    {
      body: {
        ...problem(10_101, "email.sending.error.authentication.unauthorized"),
        messages: [{ code: 0, message: "private reason" }],
      },
      status: 401,
    },
    {
      body: { ...acknowledgement, errors: [{ code: 0, message: "private warning" }] },
      status: 200,
    },
    { body: problem(10_002, "email.sending.error.internal_server"), status: 500 },
    { body: problem(10_100, "email.sending.error.authentication.upstream"), status: 503 },
    { body: problem(10_001, "email.sending.error.invalid_request_schema"), status: 400 },
    { body: acknowledgement, status: 202 },
    { body: acknowledgement, status: 409 },
  ])(
    "does not replay unreviewed statuses or incoherent refusal proof under a three-attempt policy (case %#)",
    ({ body, status }) =>
      Effect.gen(function* refuseUnsafeCloudflareRetry() {
        const fixture = yield* startEmailHttpFixture({ body: JSON.stringify(body), status });

        const result = yield* Effect.gen(function* submitAmbiguousCloudflare() {
          return yield* (yield* Email).send(message);
        }).pipe(Effect.provide(fixtureCloudflareLayer(fixture)), Effect.result);

        assert(Result.isFailure(result) && result.failure instanceof EmailDeliveryUnknown);
        assert.notInclude(JSON.stringify(result.failure), "private");
        assert.strictEqual(yield* Queue.size(fixture.received), 1);
      }),
  );

  it.effect(
    "waits at least the numeric throttling hint and resubmits unchanged intent within the same account",
    () =>
      Effect.gen(function* retryCloudflareThrottling() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify(problem(10_004, "email.sending.error.throttled")),
          next: { body: JSON.stringify(acknowledgement), status: 200 },
          retryAfter: "2",
          status: 429,
        });

        const fiber = yield* Effect.gen(function* submitThrottledCloudflare() {
          return yield* (yield* Email).send(message);
        }).pipe(Effect.provide(fixtureCloudflareLayer(fixture)), Effect.forkChild);

        const first = yield* Queue.take(fixture.received);
        yield* TestClock.adjust(Duration.millis(1999));
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
        yield* TestClock.adjust(Duration.seconds(1));
        const receipt = yield* Fiber.join(fiber);
        assert(EmailReceiptSchema.guards.Accepted(receipt));
        const second = yield* Queue.take(fixture.received);
        assert.strictEqual(second.path, first.path);
        assert.strictEqual(second.body, first.body);
        assert.strictEqual(second.authorization, first.authorization);
      }),
  );

  it.live(
    "enforces the actual UTF-8 JSON budget including attachment bytes without truncation",
    () =>
      Effect.gen(function* boundCloudflareWire() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 200,
        });

        const attachment = {
          contentBase64: Buffer.alloc(1024 * 1024).toString("base64"),
          contentType: "application/octet-stream",
          filename: "file.dat",
        };

        const seed = {
          ...message,
          attachments: [attachment],
          body: { html: "é".repeat(700_000), text: "é".repeat(500_000) },
        } as const;

        yield* Effect.gen(function* sendCloudflareBudgetSeed() {
          return yield* (yield* Email).send(seed);
        }).pipe(Effect.provide(fixtureCloudflareLayer(fixture)));
        const baseline = yield* Queue.take(fixture.received);
        const padding = 4_000_000 - Buffer.byteLength(baseline.body, "utf-8");
        assert.isAbove(padding, 0);

        const bounded = {
          ...seed,
          body: { ...seed.body, html: `${seed.body.html}${"a".repeat(padding)}` },
        };

        yield* Effect.gen(function* sendExactCloudflareBudget() {
          return yield* (yield* Email).send(bounded);
        }).pipe(Effect.provide(fixtureCloudflareLayer(fixture)));
        const exact = yield* Queue.take(fixture.received);
        assert.strictEqual(Buffer.byteLength(exact.body, "utf-8"), 4_000_000);

        const wire = yield* Schema.decodeEffect(
          Schema.fromJsonString(Schema.Struct({ html: Schema.String })),
        )(exact.body);

        assert.strictEqual(wire.html, bounded.body.html);

        const refused = yield* Effect.gen(function* exceedCloudflareBudget() {
          return yield* (yield* Email).send({
            ...bounded,
            body: { ...bounded.body, html: `${bounded.body.html}a` },
          });
        }).pipe(Effect.provide(fixtureCloudflareLayer(fixture)), Effect.result);

        assert(Result.isFailure(refused) && refused.failure instanceof EmailInvalidMessage);
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );

  it.live.each([
    { ...message, to: [message.to, message.to.toUpperCase()] },
    { ...message, replyTo: ["reply@example.test", "other@example.test"] },
    { ...message, headers: [{ name: "X-CF-Control", value: "private" }] },
    { ...message, headers: [{ name: "Message-ID", value: "private" }] },
    { ...message, headers: [{ name: "List-Unsubscribe", value: "<https://example.test>" }] },
    { ...message, headers: [{ name: "Unknown", value: "private" }] },
    { ...message, headers: [{ name: "X-Bad!", value: "private" }] },
    {
      ...message,
      headers: [
        { name: "X-Workflow", value: "private" },
        { name: "x-workflow", value: "other" },
      ],
    },
    { ...message, headers: [{ name: "X-Unicode", value: "界".repeat(700) }] },
    { ...message, metadata: { private: "value" } },
    { ...message, tags: [{ name: "private", value: "value" }] },
    { ...message, sendAt: "2026-10-14T12:30:00Z" },
    {
      ...message,
      attachments: [
        { contentBase64: "AQID", contentType: "ProviderSelected", filename: "private.dat" },
      ],
    },
  ] as const)("refuses nonrepresentable intent before HTTP (case %#)", (input) =>
    Effect.gen(function* refuseCloudflareIntent() {
      const fixture = yield* startEmailHttpFixture({
        body: JSON.stringify(acknowledgement),
        status: 200,
      });

      const result = yield* Effect.gen(function* validateCloudflareLocally() {
        return yield* (yield* Email).send(input);
      }).pipe(Effect.provide(fixtureCloudflareLayer(fixture)), Effect.result);

      assert(Result.isFailure(result) && result.failure instanceof EmailInvalidMessage);
      assert.notInclude(JSON.stringify(result.failure), "private");
      assert.strictEqual(yield* Queue.size(fixture.received), 0);
    }),
  );

  it.live("rejects ordinary/direct keys and an incompatible backup before primary HTTP", () =>
    Effect.gen(function* defendCloudflareKeysAndRouting() {
      const primary = yield* startEmailHttpFixture({
        body: JSON.stringify({ id: "primary" }),
        status: 200,
      });

      const backup = yield* startEmailHttpFixture({
        body: JSON.stringify(acknowledgement),
        status: 200,
      });

      const ordinary = yield* Effect.gen(function* keyCloudflareOrdinary() {
        return yield* (yield* Email).send(message, { idempotencyKey: "private-key" });
      }).pipe(Effect.provide(fixtureCloudflareLayer(backup)), Effect.result);

      assert(Result.isFailure(ordinary) && ordinary.failure instanceof EmailRejected);

      const direct = yield* Effect.gen(function* keyCloudflareDirect() {
        return yield* (yield* EmailSender).submit({
          idempotencyKey: EmailIdempotencyKeySchema.make("private-key"),
          message: yield* parseEmailMessage(message),
        });
      }).pipe(
        Effect.provide(
          cloudflareSenderLayer(options).pipe(
            Layer.provide(emailFixtureClientLayer(backup.url, "https://api.cloudflare.com")),
          ),
        ),
        Effect.result,
      );

      assert(Result.isFailure(direct) && direct.failure instanceof EmailRejected);

      const routed = yield* Effect.gen(function* preflightCloudflareBackup() {
        const email = yield* (yield* EmailRouter).select();

        return [
          yield* email.send(message, { idempotencyKey: "private-key" }).pipe(Effect.result),
          yield* email
            .send({ ...message, replyTo: ["reply@example.test", "other@example.test"] })
            .pipe(Effect.result),
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
              { layer: fixtureCloudflareLayer(backup), name: "backup" },
            ],
            { fallbacks: ["backup"], primary: "primary" },
          ),
        ),
      );

      assert(Result.isFailure(routed[0]) && routed[0].failure instanceof EmailRejected);
      assert(Result.isFailure(routed[1]) && routed[1].failure instanceof EmailInvalidMessage);
      assert.strictEqual(yield* Queue.size(primary.received), 0);
      assert.strictEqual(yield* Queue.size(backup.received), 0);
    }),
  );

  it.live.each([
    { field: "apiToken", value: "private-unwrapped-token" },
    { field: "apiToken", value: Redacted.make("private token") },
    { field: "apiToken", value: Redacted.make("") },
    { field: "accountId", value: "private/path?query" },
    { field: "mailFlow", value: "AllowRewriting" },
    { field: "baseUrl", value: "https://private.test" },
    ...["accountId", "apiToken", "mailFlow"].map((field) => ({ field, value: undefined })),
  ])("requires explicit owned safe credentials and account choices (case %#)", ({ field, value }) =>
    Effect.gen(function* refuseCloudflareConfiguration() {
      const fixture = yield* startEmailHttpFixture({
        body: JSON.stringify(acknowledgement),
        status: 200,
      });

      const configuration = { ...options };
      Reflect.set(configuration, field, value);

      const result = yield* Effect.service(Email).pipe(
        Effect.provide(
          cloudflareEmailLayer(configuration).pipe(
            Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.cloudflare.com")),
          ),
        ),
        Effect.result,
      );

      assert(Result.isFailure(result) && result.failure instanceof EmailConfigurationError);
      assert.notInclude(JSON.stringify(result.failure), "private");
      assert.strictEqual(yield* Queue.size(fixture.received), 0);
    }),
  );

  it.live.each([
    "not-json",
    JSON.stringify({
      ...problem(10_101, "email.sending.error.authentication.unauthorized"),
      private: "x".repeat(65_536),
    }),
  ])("does not turn malformed or oversized refusal evidence into fallback (case %#)", (body) =>
    Effect.gen(function* boundCloudflareRefusalProof() {
      const primary = yield* startEmailHttpFixture({ body, status: 401 });

      const backup = yield* startEmailHttpFixture({
        body: JSON.stringify({ id: "backup-id" }),
        status: 200,
      });

      const result = yield* Effect.gen(function* routeBoundedCloudflareRefusal() {
        return yield* (yield* (yield* EmailRouter).select()).send(message);
      }).pipe(Effect.provide(fixtureRoute(primary, backup)), Effect.result);

      assert(Result.isFailure(result) && result.failure instanceof EmailDeliveryUnknown);
      assert.strictEqual(result.failure.reason, "invalid-response");
      assert.strictEqual(yield* Queue.size(primary.received), 1);
      assert.strictEqual(yield* Queue.size(backup.received), 0);
    }),
  );

  it.live("enforces UTF-8 header value and aggregate budgets without discarding headers", () =>
    Effect.gen(function* boundCloudflareHeaders() {
      const fixture = yield* startEmailHttpFixture({
        body: JSON.stringify(acknowledgement),
        status: 200,
      });

      const first = { name: "X-H0", value: "a".repeat(998) };

      const headers = [
        first,
        ...Array.from({ length: 14 }, (_, index) => ({
          name: `X-H${index + 1}`,
          value: "a".repeat(998),
        })),
        { name: "X-H15", value: "a".repeat(896) },
      ] as const;

      const unicodeHeader = [{ name: "X-Unicode", value: `${"界".repeat(682)}aa` }] as const;
      yield* Effect.gen(function* sendBoundedCloudflareHeaders() {
        const email = yield* Email;
        yield* email.send({ ...message, headers });
        yield* email.send({ ...message, headers: unicodeHeader });

        const aggregate = yield* email
          .send({
            ...message,
            headers: [first, ...headers.slice(1, -1), { name: "X-H15", value: "a".repeat(897) }],
          })
          .pipe(Effect.result);

        const unicode = yield* email
          .send({
            ...message,
            headers: [{ ...unicodeHeader[0], value: `${unicodeHeader[0].value}a` }],
          })
          .pipe(Effect.result);

        assert(Result.isFailure(aggregate) && aggregate.failure instanceof EmailInvalidMessage);
        assert(Result.isFailure(unicode) && unicode.failure instanceof EmailInvalidMessage);
      }).pipe(Effect.provide(fixtureCloudflareLayer(fixture)));
      const exact = yield* Queue.take(fixture.received);

      const wire = yield* Schema.decodeEffect(
        Schema.fromJsonString(
          Schema.Struct({ headers: Schema.Record(Schema.String, Schema.String) }),
        ),
      )(exact.body);

      assert.strictEqual(
        Object.entries(wire.headers).reduce(
          (bytes, [name, value]) => bytes + Buffer.byteLength(name) + Buffer.byteLength(value) + 4,
          0,
        ),
        16_000,
      );
      assert.strictEqual(wire.headers["X-H15"], "a".repeat(896));
      const unicode = yield* Queue.take(fixture.received);

      const unicodeWire = yield* Schema.decodeEffect(
        Schema.fromJsonString(
          Schema.Struct({ headers: Schema.Record(Schema.String, Schema.String) }),
        ),
      )(unicode.body);

      assert.strictEqual(unicodeWire.headers["X-Unicode"], unicodeHeader[0].value);
      assert.strictEqual(yield* Queue.size(fixture.received), 0);
    }),
  );

  it.live(
    "excludes account IDs, tokens and rejected private provider reasons from NativeSpan diagnostics",
    () =>
      Effect.gen(function* inspectCloudflareRefusalPrivacy() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify(problem(10_101, "private-provider-reason")),
          status: 401,
        });

        const trace = yield* startEmailTraceFixture();

        const result = yield* Effect.gen(function* submitPrivateCloudflare() {
          return yield* (yield* Email).send(message);
        }).pipe(
          Effect.provide(fixtureCloudflareLayer(fixture)),
          Effect.provideService(Tracer.Tracer, trace.tracer),
          Effect.result,
        );

        assert(Result.isFailure(result) && result.failure instanceof EmailDeliveryUnknown);
        const diagnostics = yield* trace.diagnostics;
        assert.include(diagnostics, "Cloudflare.submit");

        for (const privateValue of [
          options.accountId,
          "fictional-cloudflare-token",
          "private-provider-reason",
          message.to,
          message.body.text,
        ]) {
          assert.notInclude(diagnostics, privateValue);
          assert.notInclude(JSON.stringify(result.failure), privateValue);
        }
      }),
  );

  it.live("owns acquired account/token/mail-flow choices despite later mutation", () =>
    Effect.gen(function* ownCloudflareConfiguration() {
      const fixture = yield* startEmailHttpFixture({
        body: JSON.stringify(acknowledgement),
        status: 200,
      });

      const configuration: CloudflareEmailOptions = { ...options };
      yield* Effect.gen(function* mutateCloudflareAfterAcquisition() {
        const email = yield* Email;
        Reflect.set(configuration, "accountId", "abcdef0123456789abcdef0123456789");
        Reflect.set(configuration, "apiToken", Redacted.make("private-mutated"));
        Reflect.set(configuration, "mailFlow", "AllowRewriting");
        yield* email.send(message);
      }).pipe(
        Effect.provide(
          cloudflareEmailLayer(configuration).pipe(
            Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.cloudflare.com")),
          ),
        ),
      );
      const sent = yield* Queue.take(fixture.received);
      assert.strictEqual(sent.path, `/client/v4/accounts/${options.accountId}/email/sending/send`);
      assert.strictEqual(sent.authorization, "Bearer fictional-cloudflare-token");
    }),
  );
});
