import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Layer, Queue, Redacted, Result, Schema } from "effect";
import { emailFixtureClientLayer, startEmailHttpFixture } from "../test/email-http-fixture.js";
import type { EmailHttpFixture } from "../test/email-http-fixture.js";
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
  parseEmailMessage,
  emailRouterLayer,
} from "./index.js";
import { mailtrapEmailLayer, mailtrapSenderLayer } from "./mailtrap-email-sender.js";
import { resendEmailLayer } from "./resend-email-sender.js";

const message = {
  body: { html: "<p>Synthetic café {{literal}}</p>", text: "Synthetic café {{literal}}" },
  from: { address: "sender@example.test", name: 'Fictional "Café"' },
  subject: "Synthetic Mailtrap notification",
  to: ["recipient@example.test"],
} as const;

const options = {
  apiKey: Redacted.make("fictional-mailtrap-key"),
  automaticBcc: "DomainDisabled",
  automaticFooter: "DomainDisabled",
  tracking: "DomainDisabled",
} as const;

const policy = {
  deadline: Duration.seconds(5),
  initialDelay: Duration.millis(100),
  maxAttempts: 3,
};

const acknowledgement = { message_ids: ["private-opaque-id"], success: true };

const fixtureMailtrapLayer = (fixture: EmailHttpFixture) =>
  mailtrapEmailLayer(options, policy).pipe(
    Layer.provide(emailFixtureClientLayer(fixture.url, "https://send.api.mailtrap.io")),
  );

const fixtureMailtrapRoute = (primary: EmailHttpFixture, backup: EmailHttpFixture) =>
  emailRouterLayer(
    [
      { layer: fixtureMailtrapLayer(primary), name: "primary" },
      {
        layer: resendEmailLayer({ apiKey: Redacted.make("fictional-backup-key") }, policy).pipe(
          Layer.provide(emailFixtureClientLayer(backup.url, "https://api.resend.com")),
        ),
        name: "backup",
      },
    ],
    { fallbacks: ["backup"], primary: "primary" },
  );

const routedSend = Effect.gen(function* submitMailtrapRoute() {
  return yield* (yield* (yield* EmailRouter).select()).send(message);
});

const MailtrapWire = Schema.Struct({
  attachments: Schema.Array(
    Schema.Struct({
      content: Schema.String,
      content_id: Schema.optionalKey(Schema.String),
      disposition: Schema.String,
      filename: Schema.String,
      type: Schema.optionalKey(Schema.String),
    }),
  ),
  bcc: Schema.Array(Schema.Struct({ email: Schema.String, name: Schema.String })),
  category: Schema.String,
  cc: Schema.Array(Schema.Struct({ email: Schema.String, name: Schema.String })),
  custom_variables: Schema.Record(Schema.String, Schema.String),
  from: Schema.Struct({ email: Schema.String, name: Schema.String }),
  headers: Schema.Record(Schema.String, Schema.String),
  html: Schema.String,
  reply_to: Schema.Struct({ email: Schema.String, name: Schema.String }),
  subject: Schema.String,
  text: Schema.String,
  to: Schema.Array(
    Schema.Struct({ email: Schema.String, name: Schema.optionalKey(Schema.String) }),
  ),
});

describe("Mailtrap actual transactional protocol", () => {
  it.live(
    "preserves structured group intent, literal bodies, native metadata and every MIME/CID byte",
    () =>
      Effect.gen(function* inspectMailtrapWire() {
        const ids = ["opaque-hidden", "opaque-second", "opaque-copy", "opaque-first"];

        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify({ message_ids: ids, success: true }),
          status: 200,
        });

        const receipt = yield* Effect.gen(function* submitRichMailtrapIntent() {
          return yield* (yield* Email).send({
            ...message,
            attachments: [
              {
                contentBase64: "AP+ACg==",
                contentType: "application/octet-stream",
                filename: "sample.dat",
              },
              {
                contentBase64: "AQ==",
                contentId: "pixel",
                contentType: "image/png",
                filename: "sample.png",
              },
              { contentBase64: "Ag==", contentType: "ProviderSelected", filename: "delegated.dat" },
            ],
            bcc: { address: "hidden@example.test", name: "Fictional Hidden" },
            cc: { address: "copy@example.test", name: "Fictional Copy" },
            headers: [{ name: "X-Workflow", value: "synthetic" }],
            metadata: { workflow: "synthetic café" },
            replyTo: { address: "reply@example.test", name: "Fictional Reply" },
            tags: [{ name: "workflow", value: "synthetic:通知" }],
            to: [{ address: "first@example.test", name: "First Fictional" }, "second@example.test"],
          });
        }).pipe(Effect.provide(fixtureMailtrapLayer(fixture)));

        assert(EmailReceiptSchema.guards.AcceptedWithIds(receipt));
        assert.deepStrictEqual(receipt.messageIds.map(String), ids);
        assert.isTrue(Object.isFrozen(receipt));
        assert.isTrue(Object.isFrozen(receipt.messageIds));
        assert.isFalse("messageId" in receipt);
        assert.isFalse("recipients" in receipt);
        const sent = yield* Queue.take(fixture.received);
        assert.strictEqual(sent.method, "POST");
        assert.strictEqual(sent.path, "/api/send");
        assert.strictEqual(sent.apiToken, "fictional-mailtrap-key");
        assert.strictEqual(sent.authorization, "");
        assert.strictEqual(sent.userAgent, "corven-email-sdk");
        assert.strictEqual(sent.idempotencyKey, "");
        const wire = yield* Schema.decodeEffect(Schema.fromJsonString(MailtrapWire))(sent.body);
        assert.deepStrictEqual(wire.from, { email: message.from.address, name: message.from.name });
        assert.deepStrictEqual(wire.to, [
          { email: "first@example.test", name: "First Fictional" },
          { email: "second@example.test" },
        ]);
        assert.deepStrictEqual(wire.cc, [{ email: "copy@example.test", name: "Fictional Copy" }]);
        assert.deepStrictEqual(wire.bcc, [
          { email: "hidden@example.test", name: "Fictional Hidden" },
        ]);
        assert.deepStrictEqual(wire.reply_to, {
          email: "reply@example.test",
          name: "Fictional Reply",
        });
        assert.strictEqual(wire.subject, message.subject);
        assert.strictEqual(wire.html, message.body.html);
        assert.strictEqual(wire.text, message.body.text);
        assert.strictEqual(wire.headers["X-Workflow"], "synthetic");
        assert.strictEqual(wire.custom_variables.workflow, "synthetic café");
        assert.strictEqual(wire.category, "workflow:synthetic:通知");
        const [ordinary, inline, delegated] = wire.attachments;
        assert.isDefined(ordinary);
        assert.isDefined(inline);
        assert.isDefined(delegated);
        assert.deepStrictEqual([...Buffer.from(ordinary.content, "base64")], [0, 255, 128, 10]);
        assert.strictEqual(ordinary.type, "application/octet-stream");
        assert.strictEqual(ordinary.disposition, "attachment");
        assert.isFalse("content_id" in ordinary);
        assert.deepStrictEqual([...Buffer.from(inline.content, "base64")], [1]);
        assert.strictEqual(inline.type, "image/png");
        assert.strictEqual(inline.content_id, "pixel");
        assert.strictEqual(inline.filename, "sample.png");
        assert.strictEqual(inline.disposition, "inline");
        assert.deepStrictEqual([...Buffer.from(delegated.content, "base64")], [2]);
        assert.strictEqual(delegated.filename, "delegated.dat");
        assert.isFalse("type" in delegated);
        assert.notInclude(sent.body, '"template_uuid"');
        assert.notInclude(sent.body, '"template_variables"');
        assert.notInclude(sent.body, '"ProviderSelected"');
      }),
  );

  it.effect.each([1, 2, 50])(
    "retains %i unordered IDs as terminal evidence without inventing address correlation",
    (total) =>
      Effect.gen(function* preserveMailtrapIds() {
        const ids = Array.from({ length: total }, (_, index) => `private-id-${total - index}`);

        const primary = yield* startEmailHttpFixture({
          body: JSON.stringify({ message_ids: ids, success: true }),
          status: 200,
        });

        const backup = yield* startEmailHttpFixture({
          body: JSON.stringify({ id: "backup-id" }),
          status: 200,
        });

        const receipt = yield* Effect.gen(function* submitMailtrapAudience() {
          return yield* (yield* (yield* EmailRouter).select()).send({
            ...message,
            to: [
              "first@example.test",
              ...Array.from({ length: total - 1 }, (_, index) => `member-${index}@example.test`),
            ],
          });
        }).pipe(Effect.provide(fixtureMailtrapRoute(primary, backup)));

        assert(EmailReceiptSchema.guards.AcceptedWithIds(receipt));
        assert.strictEqual(receipt.route, "primary");
        assert.deepStrictEqual(receipt.messageIds.map(String), ids);
        assert.isTrue(Object.isFrozen(receipt.messageIds));
        assert.isFalse("accepted" in receipt);
        assert.isFalse("messageId" in receipt);
        assert.strictEqual(yield* Queue.size(primary.received), 1);
        assert.strictEqual(yield* Queue.size(backup.received), 0);
      }),
  );

  it.live.each([
    {},
    { message_ids: ["opaque-id"], success: false },
    { message_ids: [], success: true },
    { message_ids: ["invalid id"], success: true },
    { message_ids: ["id", "id"], success: true },
    { message_ids: ["id", "other"], success: true },
    { errors: ["private-suppression"], message_ids: ["id"], success: true },
    { error: "private-error", message_ids: ["id"], success: true },
    { message_ids: Array.from({ length: 51 }, (_, index) => `id-${index}`), success: true },
  ])(
    "keeps missing, contradictory, duplicate or foreign-cardinality acknowledgement unknown (%j)",
    (body) =>
      Effect.gen(function* rejectMailtrapAcknowledgement() {
        const primary = yield* startEmailHttpFixture({ body: JSON.stringify(body), status: 200 });

        const backup = yield* startEmailHttpFixture({
          body: JSON.stringify({ id: "backup-id" }),
          status: 200,
        });

        const outcome = yield* routedSend.pipe(
          Effect.provide(fixtureMailtrapRoute(primary, backup)),
          Effect.result,
        );

        assert(Result.isFailure(outcome));
        assert(outcome.failure instanceof EmailDeliveryUnknown);
        assert.strictEqual(outcome.failure.reason, "invalid-response");
        assert.notInclude(JSON.stringify(outcome.failure), "private-");
        assert.strictEqual(yield* Queue.size(primary.received), 1);
        assert.strictEqual(yield* Queue.size(backup.received), 0);
      }),
  );

  it.live.each([302, 400, 409, 422, 429, 500, 503, 504])(
    "never borrows safe replay or fallback from unclassified status %s",
    (status) =>
      Effect.gen(function* preserveMailtrapUncertainty() {
        const primary = yield* startEmailHttpFixture({
          body: JSON.stringify({ errors: ["private-rate-or-quota"], success: false }),
          retryAfter: "0",
          status,
        });

        const backup = yield* startEmailHttpFixture({
          body: JSON.stringify({ id: "backup-id" }),
          status: 200,
        });

        const outcome = yield* routedSend.pipe(
          Effect.provide(fixtureMailtrapRoute(primary, backup)),
          Effect.result,
        );

        assert(Result.isFailure(outcome));
        assert(outcome.failure instanceof EmailDeliveryUnknown);
        assert.strictEqual(outcome.failure.status, status);
        assert.notInclude(JSON.stringify(outcome.failure), "private-");
        assert.strictEqual(yield* Queue.size(primary.received), 1);
        assert.strictEqual(yield* Queue.size(backup.received), 0);
      }),
  );

  it.live.each([401, 403])(
    "allows fallback only after documented whole-request refusal %s",
    (status) =>
      Effect.gen(function* fallbackMailtrapRefusal() {
        const primary = yield* startEmailHttpFixture({
          body: JSON.stringify({ errors: ["private-refusal"], success: false }),
          status,
        });

        const backup = yield* startEmailHttpFixture({
          body: JSON.stringify({ id: "backup-id" }),
          status: 200,
        });

        const receipt = yield* routedSend.pipe(
          Effect.provide(fixtureMailtrapRoute(primary, backup)),
        );

        assert(EmailReceiptSchema.guards.Accepted(receipt));
        assert.strictEqual(receipt.route, "backup");
        assert.strictEqual(yield* Queue.size(primary.received), 1);
        assert.strictEqual(yield* Queue.size(backup.received), 1);
      }),
  );

  it.live.each([
    { errors: "private-refusal", success: false },
    { errors: ["private-refusal"], success: true },
    { errors: [], success: false },
    { errors: ["private-refusal"], message_ids: ["private-id"], success: false },
    { error: "private-conflict", errors: ["private-refusal"], success: false },
  ])(
    "does not turn malformed or contradictory authentication failures into fallback (%j)",
    (body) =>
      Effect.gen(function* rejectMailtrapRefusalProof() {
        const primary = yield* startEmailHttpFixture({ body: JSON.stringify(body), status: 401 });

        const backup = yield* startEmailHttpFixture({
          body: JSON.stringify({ id: "backup-id" }),
          status: 200,
        });

        const outcome = yield* routedSend.pipe(
          Effect.provide(fixtureMailtrapRoute(primary, backup)),
          Effect.result,
        );

        assert(Result.isFailure(outcome));
        assert(outcome.failure instanceof EmailDeliveryUnknown);
        assert.notInclude(JSON.stringify(outcome.failure), "private-");
        assert.strictEqual(yield* Queue.size(primary.received), 1);
        assert.strictEqual(yield* Queue.size(backup.received), 0);
      }),
  );

  it.live.each([
    { ...message, sendAt: "2026-10-14T12:30:00Z" },
    { ...message, replyTo: ["reply@example.test", "other@example.test"] },
    { ...message, cc: "RECIPIENT@example.test" },
    { ...message, body: { html: '<a href="__unsubscribe_url__">stop</a>' } },
    { ...message, body: { text: "__unsubscribe_url__" } },
    { ...message, headers: [{ name: "X-MT-Custom-Variables", value: "private-value" }] },
    { ...message, headers: [{ name: "Api-Token", value: "private-value" }] },
    { ...message, headers: [{ name: "User-Agent", value: "private-value" }] },
    {
      ...message,
      headers: [{ name: "List-Unsubscribe", value: "https://example.test/unsubscribe" }],
    },
    { ...message, tags: [{ name: "a:b", value: "c" }] },
    {
      ...message,
      tags: [
        { name: "a", value: "b" },
        { name: "c", value: "d" },
      ],
    },
    { ...message, tags: [{ name: "a", value: "v".repeat(254) }] },
    { ...message, metadata: { workflow: "界".repeat(329) } },
  ] as const)(
    "rejects unsupported or silently lossy intent before either routed candidate (%j)",
    (input) =>
      Effect.gen(function* preflightMailtrapIntent() {
        const primary = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 200,
        });

        const backup = yield* startEmailHttpFixture({
          body: JSON.stringify({ id: "backup-id" }),
          status: 200,
        });

        const outcome = yield* Effect.gen(function* submitInvalidMailtrapIntent() {
          return yield* (yield* (yield* EmailRouter).select()).send(input);
        }).pipe(Effect.provide(fixtureMailtrapRoute(primary, backup)), Effect.result);

        assert(Result.isFailure(outcome));
        assert(outcome.failure instanceof EmailInvalidMessage);
        assert.notInclude(JSON.stringify(outcome.failure), "private-");
        assert.strictEqual(yield* Queue.size(primary.received), 0);
        assert.strictEqual(yield* Queue.size(backup.received), 0);
      }),
  );

  it.live("accepts exact UTF-8 metadata and category boundaries without truncation", () =>
    Effect.gen(function* inspectMailtrapBounds() {
      const fixture = yield* startEmailHttpFixture({
        body: JSON.stringify(acknowledgement),
        status: 200,
      });

      const receipt = yield* Effect.gen(function* submitBoundedMailtrapIntent() {
        return yield* (yield* Email).send({
          ...message,
          metadata: { workflow: `${"界".repeat(328)}a` },
          tags: [{ name: "a", value: "v".repeat(253) }],
        });
      }).pipe(Effect.provide(fixtureMailtrapLayer(fixture)));

      assert(EmailReceiptSchema.guards.AcceptedWithIds(receipt));
      const sent = yield* Queue.take(fixture.received);

      const wire = yield* Schema.decodeEffect(
        Schema.fromJsonString(
          Schema.Struct({
            category: Schema.String,
            custom_variables: Schema.Record(Schema.String, Schema.String),
          }),
        ),
      )(sent.body);

      assert.strictEqual(Buffer.byteLength(JSON.stringify(wire.custom_variables)), 1000);
      assert.strictEqual(wire.custom_variables.workflow, `${"界".repeat(328)}a`);
      assert.strictEqual(wire.category, `a:${"v".repeat(253)}`);
    }),
  );

  it.live("refuses ignored keys before ordinary and all-candidate transport", () =>
    Effect.gen(function* rejectMailtrapKeys() {
      const primary = yield* startEmailHttpFixture({
        body: JSON.stringify(acknowledgement),
        status: 200,
      });

      const backup = yield* startEmailHttpFixture({
        body: JSON.stringify({ id: "backup-id" }),
        status: 200,
      });

      for (const layer of [fixtureMailtrapLayer(primary), fixtureMailtrapRoute(primary, backup)]) {
        const outcome = yield* Effect.gen(function* submitUnsupportedMailtrapKey() {
          return yield* (yield* Email).send(message, { idempotencyKey: "private-key" });
        }).pipe(Effect.provide(layer), Effect.result);

        assert(Result.isFailure(outcome));
        assert(outcome.failure instanceof EmailRejected);
        assert.strictEqual(outcome.failure.reason, "unsupported-idempotency");
        assert.notInclude(JSON.stringify(outcome.failure), "private-key");
      }

      assert.strictEqual(yield* Queue.size(primary.received), 0);
      assert.strictEqual(yield* Queue.size(backup.received), 0);
    }),
  );

  it.live(
    "defends unkeyed direct authority and preflights a Mailtrap backup before primary HTTP",
    () =>
      Effect.gen(function* defendMailtrapAuthority() {
        const mailtrap = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 200,
        });

        const resend = yield* startEmailHttpFixture({
          body: JSON.stringify({ id: "resend-id" }),
          status: 200,
        });

        const direct = yield* Effect.gen(function* submitDirectMailtrapKey() {
          const sender = yield* EmailSender;
          assert.strictEqual(sender.idempotency._tag, "None");
          assert.isTrue(Object.isFrozen(sender.idempotency));

          return yield* sender.submit({
            idempotencyKey: EmailIdempotencyKeySchema.make("private-key"),
            message: yield* parseEmailMessage(message),
          });
        }).pipe(
          Effect.provide(
            mailtrapSenderLayer(options).pipe(
              Layer.provide(emailFixtureClientLayer(mailtrap.url, "https://send.api.mailtrap.io")),
            ),
          ),
          Effect.result,
        );

        assert(Result.isFailure(direct));
        assert(direct.failure instanceof EmailRejected);
        assert.strictEqual(direct.failure.reason, "unsupported-idempotency");

        const routed = yield* Effect.gen(function* submitKeyedMailtrapBackup() {
          return yield* (yield* Email).send(message, { idempotencyKey: "private-key" });
        }).pipe(
          Effect.provide(
            emailRouterLayer(
              [
                {
                  layer: resendEmailLayer({ apiKey: Redacted.make("fictional-key") }, policy).pipe(
                    Layer.provide(emailFixtureClientLayer(resend.url, "https://api.resend.com")),
                  ),
                  name: "primary",
                },
                { layer: fixtureMailtrapLayer(mailtrap), name: "backup" },
              ],
              { fallbacks: ["backup"], primary: "primary" },
            ),
          ),
          Effect.result,
        );

        assert(Result.isFailure(routed));
        assert(routed.failure instanceof EmailRejected);
        assert.strictEqual(routed.failure.reason, "unsupported-idempotency");
        assert.strictEqual(yield* Queue.size(mailtrap.received), 0);
        assert.strictEqual(yield* Queue.size(resend.received), 0);
      }),
  );

  it.live("owns construction credentials and attestations before the caller can mutate them", () =>
    Effect.gen(function* ownMailtrapConfiguration() {
      const fixture = yield* startEmailHttpFixture({
        body: JSON.stringify(acknowledgement),
        status: 200,
      });

      const mutable = { ...options, apiKey: Redacted.make("fictional-initial-key") };

      const receipt = yield* Effect.gen(function* mutateMailtrapConfiguration() {
        const email = yield* Email;
        mutable.apiKey = Redacted.make("private-mutated-key");

        return yield* email.send(message);
      }).pipe(
        Effect.provide(
          mailtrapEmailLayer(mutable, policy).pipe(
            Layer.provide(emailFixtureClientLayer(fixture.url, "https://send.api.mailtrap.io")),
          ),
        ),
      );

      assert(EmailReceiptSchema.guards.AcceptedWithIds(receipt));
      assert.strictEqual((yield* Queue.take(fixture.received)).apiToken, "fictional-initial-key");
      assert.notInclude(JSON.stringify(receipt), "private-mutated-key");
    }),
  );

  it.live.each(["tracking", "automaticBcc", "automaticFooter"])(
    "rejects missing untyped account attestation %s before transport",
    (field) =>
      Effect.gen(function* rejectMissingMailtrapAttestation() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 200,
        });

        const untyped = { ...options };
        Reflect.deleteProperty(untyped, field);

        const outcome = yield* Effect.service(Email).pipe(
          Effect.provide(
            mailtrapEmailLayer(untyped).pipe(
              Layer.provide(emailFixtureClientLayer(fixture.url, "https://send.api.mailtrap.io")),
            ),
          ),
          Effect.result,
        );

        assert(Result.isFailure(outcome));
        assert(outcome.failure instanceof EmailConfigurationError);
        assert.deepStrictEqual(
          outcome.failure.issues.map(({ path }) => path),
          [field],
        );
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );

  it.live.each(["", "private key", "private\nkey", "private-κλειδί"])(
    "rejects malformed Redacted credentials without retaining text (%s)",
    (apiKey) =>
      Effect.gen(function* rejectMailtrapCredential() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 200,
        });

        const outcome = yield* Effect.service(Email).pipe(
          Effect.provide(
            mailtrapEmailLayer({ ...options, apiKey: Redacted.make(apiKey) }).pipe(
              Layer.provide(emailFixtureClientLayer(fixture.url, "https://send.api.mailtrap.io")),
            ),
          ),
          Effect.result,
        );

        assert(Result.isFailure(outcome));
        assert(outcome.failure instanceof EmailConfigurationError);
        assert.notInclude(JSON.stringify(outcome.failure), "private");
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );
});
