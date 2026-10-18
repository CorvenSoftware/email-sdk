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
  EmailInvalidOptions,
  EmailReceiptSchema,
  EmailRejected,
  EmailRouter,
  emailRouterLayer,
  emailAttachmentFromBytes,
} from "./index.js";
import { heloEmailLayer } from "./helo-email-sender.js";
import { resendEmailLayer } from "./resend-email-sender.js";

const message = {
  body: { html: "<p>Synthetic café</p>", text: "Synthetic café" },
  from: "sender@example.test",
  subject: "Synthetic Helo notification",
  to: ["first@example.test", "second@example.test"],
} as const;

const messageId = "01930f2a-4b3c-7d8e-9f0a-1b2c3d4e5f6a";

const channelId = "550e8400-e29b-41d4-a716-446655440000";

const options = {
  apiKey: Redacted.make("fictional-api-key"),
  channelId,
  channelMode: "Live",
} as const;

const policy = { deadline: Duration.seconds(5), initialDelay: Duration.millis(1), maxAttempts: 1 };

const acknowledgement = { messageId, status: "accepted" };

const fixtureHeloLayer = (
  fixture: EmailHttpFixture,
  maxAttempts = 1,
  channelMode: "Live" | "Sandbox" = "Live",
) =>
  heloEmailLayer({ ...options, channelMode }, { ...policy, maxAttempts }).pipe(
    Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.helohq.com")),
  );

const fixtureHeloRoute = (
  primary: EmailHttpFixture,
  backup: EmailHttpFixture,
  maxAttempts = 1,
  channelMode: "Live" | "Sandbox" = "Live",
) =>
  emailRouterLayer(
    [
      { layer: fixtureHeloLayer(primary, maxAttempts, channelMode), name: "primary" },
      {
        layer: resendEmailLayer({ apiKey: Redacted.make("fictional-backup-key") }, policy).pipe(
          Layer.provide(emailFixtureClientLayer(backup.url, "https://api.resend.com")),
        ),
        name: "backup",
      },
    ],
    { fallbacks: ["backup"], primary: "primary" },
  );

const sendHeloRoute = Effect.gen(function* submitHeloRoute() {
  return yield* (yield* (yield* EmailRouter).select()).send(message, {
    idempotencyKey: "synthetic-stable-key",
  });
});

describe("Helo actual transactional protocol", () => {
  it.live(
    "preserves rich intent, channel/key authority and binary placement while disabling tracking",
    () =>
      Effect.gen(function* inspectHeloWire() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 200,
        });

        const receipt = yield* Effect.gen(function* submitRichHeloMessage() {
          const explicit = yield* emailAttachmentFromBytes(new Uint8Array([0, 255, 128, 10]), {
            contentType: "text/plain",
            filename: "sample.txt",
          });

          const delegated = yield* emailAttachmentFromBytes(new Uint8Array([255, 0, 1]), {
            contentId: "logo",
            contentType: "ProviderSelected",
            filename: "sample.png",
          });

          return yield* (yield* Email).send(
            {
              ...message,
              attachments: [explicit, delegated],
              bcc: "hidden@example.test",
              cc: { address: "copy@example.test", name: "Fictional Copy" },
              from: { address: message.from, name: "Fictional Café" },
              headers: [{ name: "X-Workflow", value: "synthetic-value" }],
              metadata: { workflow: "synthetic" },
              replyTo: [
                { address: "reply@example.test", name: "Fictional Reply" },
                "other@example.test",
              ],
              tags: [{ name: "purpose", value: "synthetic café" }],
              to: [{ address: message.to[0], name: "Doe, Fictional" }, message.to[1]],
            },
            { idempotencyKey: "synthetic-job-key" },
          );
        }).pipe(Effect.provide(fixtureHeloLayer(fixture)));

        assert(EmailReceiptSchema.guards.Accepted(receipt));
        assert.strictEqual(receipt.messageId, messageId);
        assert.isTrue(Object.isFrozen(receipt));
        const request = yield* Queue.take(fixture.received);
        assert.strictEqual(request.path, "/send/transactional");
        assert.strictEqual(request.method, "POST");
        assert.strictEqual(request.authorization, "Bearer fictional-api-key");
        assert.strictEqual(request.heloChannelId, channelId);
        assert.strictEqual(request.heloIdempotencyKey, "synthetic-job-key");
        assert.strictEqual(request.idempotencyKey, "");

        const wire = yield* Schema.decodeEffect(
          Schema.fromJsonString(
            Schema.Struct({
              attachments: Schema.Array(
                Schema.Struct({
                  content: Schema.String,
                  contentId: Schema.optionalKey(Schema.String),
                  contentType: Schema.optionalKey(Schema.String),
                  disposition: Schema.String,
                  fileName: Schema.String,
                }),
              ),
              bcc: Schema.Array(Schema.Struct({ email: Schema.String })),
              cc: Schema.Array(Schema.Struct({ email: Schema.String, name: Schema.String })),
              from: Schema.Struct({ email: Schema.String, name: Schema.String }),
              headers: Schema.Record(Schema.String, Schema.String),
              html: Schema.String,
              metadata: Schema.Record(Schema.String, Schema.String),
              replyTo: Schema.Array(
                Schema.Struct({ email: Schema.String, name: Schema.optionalKey(Schema.String) }),
              ),
              subject: Schema.String,
              tags: Schema.Array(Schema.String),
              text: Schema.String,
              to: Schema.Array(
                Schema.Struct({ email: Schema.String, name: Schema.optionalKey(Schema.String) }),
              ),
              tracking: Schema.Struct({ links: Schema.Boolean, opens: Schema.Boolean }),
            }),
          ),
        )(request.body);

        assert.strictEqual(wire.from.name, "Fictional Café");
        assert.strictEqual(wire.from.email, message.from);
        assert.strictEqual(wire.to[0]?.name, "Doe, Fictional");
        assert.deepStrictEqual(
          wire.to.map(({ email }) => email),
          [...message.to],
        );
        assert.strictEqual(wire.cc[0]?.email, "copy@example.test");
        assert.strictEqual(wire.bcc[0]?.email, "hidden@example.test");
        assert.deepStrictEqual(
          wire.replyTo.map(({ email }) => email),
          ["reply@example.test", "other@example.test"],
        );
        assert.strictEqual(wire.replyTo[0]?.name, "Fictional Reply");
        assert.strictEqual(wire.headers["X-Workflow"], "synthetic-value");
        assert.strictEqual(wire.metadata.workflow, "synthetic");
        assert.deepStrictEqual(wire.tags, ["purpose:synthetic café"]);
        assert.strictEqual(wire.subject, message.subject);
        assert.strictEqual(wire.html, message.body.html);
        assert.strictEqual(wire.text, message.body.text);
        assert.deepStrictEqual(wire.tracking, { links: false, opens: false });
        const [explicit, delegated] = wire.attachments;
        assert.isDefined(explicit);
        assert.isDefined(delegated);
        assert.strictEqual(explicit.fileName, "sample.txt");
        assert.strictEqual(explicit.contentType, "text/plain");
        assert.strictEqual(explicit.disposition, "attachment");
        assert.isUndefined(explicit.contentId);
        assert.deepStrictEqual([...Buffer.from(explicit.content, "base64")], [0, 255, 128, 10]);
        assert.strictEqual(delegated.fileName, "sample.png");
        assert.strictEqual(delegated.contentId, "logo");
        assert.strictEqual(delegated.disposition, "inline");
        assert.isUndefined(delegated.contentType);
        assert.deepStrictEqual([...Buffer.from(delegated.content, "base64")], [255, 0, 1]);
      }),
  );

  it.live.each([
    {
      body: { ...acknowledgement, suppressions: ["SECOND@EXAMPLE.TEST"] },
      status: 200,
      tag: "PartiallyAccepted",
    },
    {
      body: {
        errorCode: "recipients_suppressed",
        errorMessage: "private-reason",
        status: "failed",
      },
      status: 200,
      tag: "Suppressed",
    },
    {
      body: { code: "recipients_suppressed", detail: "private-reason" },
      status: 422,
      tag: "Suppressed",
    },
    {
      body: {
        errorCode: "recipients_suppressed",
        status: "failed",
        suppressions: ["SECOND@example.test", "FIRST@example.test"],
      },
      status: 200,
      tag: "Suppressed",
    },
  ])("owns $tag partitions and stops real backup without leaking evidence", (scenario) =>
    Effect.gen(function* observeHeloSuppression() {
      const primary = yield* startEmailHttpFixture({
        body: JSON.stringify(scenario.body),
        status: scenario.status,
      });

      const backup = yield* startEmailHttpFixture({
        body: JSON.stringify({ id: "backup-id" }),
        status: 200,
      });

      const trace = yield* startEmailTraceFixture();

      const receipt = yield* sendHeloRoute.pipe(
        Effect.provide(fixtureHeloRoute(primary, backup)),
        Effect.provideService(Tracer.Tracer, trace.tracer),
      );

      assert.strictEqual(receipt._tag, scenario.tag);
      assert.strictEqual(receipt.route, "primary");

      if (EmailReceiptSchema.guards.PartiallyAccepted(receipt)) {
        assert.deepStrictEqual(receipt.accepted.map(String), [message.to[0]]);
        assert.deepStrictEqual(receipt.suppressed.map(String), [message.to[1]]);
        assert.isTrue(Object.isFrozen(receipt.accepted));
        assert.strictEqual(receipt.messageId, messageId);
      } else {
        assert(EmailReceiptSchema.guards.Suppressed(receipt));
        assert.deepStrictEqual(receipt.suppressed.map(String), [...message.to]);
      }

      assert.isTrue(Object.isFrozen(receipt.suppressed));
      assert.isTrue(Object.isFrozen(receipt));
      assert.notInclude(JSON.stringify(receipt), "private-reason");
      const diagnostics = yield* trace.diagnostics;
      assert.notInclude(diagnostics, "@example.test");
      assert.notInclude(diagnostics, messageId);
      assert.notInclude(diagnostics, "private-reason");
      assert.strictEqual(yield* Queue.size(backup.received), 0);
    }),
  );

  it.live("partitions suppression across to/cc/bcc in submitted order and mailbox spelling", () =>
    Effect.gen(function* observeHeloRecipientVisibility() {
      const primary = yield* startEmailHttpFixture({
        body: JSON.stringify({
          ...acknowledgement,
          suppressions: ["HIDDEN@example.test", "SECOND@example.test"],
        }),
        status: 200,
      });

      const backup = yield* startEmailHttpFixture({
        body: JSON.stringify({ id: "backup-id" }),
        status: 200,
      });

      const receipt = yield* Effect.gen(function* submitHeloVisibility() {
        return yield* (yield* (yield* EmailRouter).select()).send({
          ...message,
          bcc: "hidden@example.test",
          cc: "copy@example.test",
        });
      }).pipe(Effect.provide(fixtureHeloRoute(primary, backup)));

      assert(EmailReceiptSchema.guards.PartiallyAccepted(receipt));
      assert.deepStrictEqual(receipt.accepted.map(String), [message.to[0], "copy@example.test"]);
      assert.deepStrictEqual(receipt.suppressed.map(String), [
        message.to[1],
        "hidden@example.test",
      ]);
      assert.isTrue(Object.isFrozen(receipt.accepted));
      assert.isTrue(Object.isFrozen(receipt.suppressed));
      assert.strictEqual(yield* Queue.size(backup.received), 0);
    }),
  );

  it.live.each([[], ["second@example.test"]])(
    "reports configured sandbox submission without live fallback (%j)",
    (suppressions) =>
      Effect.gen(function* simulateHeloChannel() {
        const primary = yield* startEmailHttpFixture({
          body: JSON.stringify({ ...acknowledgement, suppressions }),
          status: 200,
        });

        const backup = yield* startEmailHttpFixture({
          body: JSON.stringify({ id: "backup-id" }),
          status: 200,
        });

        const receipt = yield* sendHeloRoute.pipe(
          Effect.provide(fixtureHeloRoute(primary, backup, 1, "Sandbox")),
        );

        assert(EmailReceiptSchema.guards.Simulated(receipt));
        assert.strictEqual(receipt.messageId, messageId);
        assert.strictEqual(receipt.route, "primary");
        assert.isTrue(Object.isFrozen(receipt));
        assert.strictEqual(yield* Queue.size(backup.received), 0);
      }),
  );

  it.live.each([
    {},
    { messageId, status: "delayed" },
    { errorCode: "recipients_suppressed", messageId, status: "failed" },
    { errorCode: "validation_failed", messageId, status: "accepted" },
    { ...acknowledgement, messageId: "not-a-uuid" },
    { ...acknowledgement, suppressions: ["foreign@example.test"] },
    { ...acknowledgement, suppressions: ["first@example.test", "FIRST@example.test"] },
    { ...acknowledgement, suppressions: [...message.to] },
    { errorCode: "unknown", errorMessage: "private-reason", status: "failed" },
    { errorCode: "recipients_suppressed", status: "failed", suppressions: [message.to[0]] },
    { errorCode: "validation_failed", status: "failed", suppressions: [message.to[0]] },
  ])(
    "keeps incomplete/contradictory/delayed acknowledgement unknown, non-replayed and non-fallback (%j)",
    (body) =>
      Effect.gen(function* rejectUnprovenHeloAcceptance() {
        const primary = yield* startEmailHttpFixture({ body: JSON.stringify(body), status: 200 });

        const backup = yield* startEmailHttpFixture({
          body: JSON.stringify({ id: "backup-id" }),
          status: 200,
        });

        const outcome = yield* sendHeloRoute.pipe(
          Effect.provide(fixtureHeloRoute(primary, backup, 3)),
          Effect.result,
        );

        assert(Result.isFailure(outcome) && outcome.failure instanceof EmailDeliveryUnknown);
        assert.strictEqual(outcome.failure.reason, "invalid-response");
        assert.notInclude(JSON.stringify(outcome.failure), "private");
        assert.strictEqual(yield* Queue.size(primary.received), 1);
        assert.strictEqual(yield* Queue.size(backup.received), 0);
      }),
  );

  it.live(
    "accepts the full locally supported recipient/subject/tag/metadata/header budgets without loss",
    () =>
      Effect.gen(function* acceptHeloIntentBounds() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 200,
        });

        const receipt = yield* Effect.gen(function* submitBoundedHeloIntent() {
          return yield* (yield* Email).send({
            ...message,
            headers: [
              { name: "X-A0", value: "x".repeat(996) },
              ...Array.from({ length: 4 }, (_, index) => ({
                name: `X-A${index + 1}`,
                value: "x".repeat(996),
              })),
            ],
            metadata: Object.fromEntries(
              Array.from({ length: 10 }, (_, index) => [
                `${"m".repeat(49)}${index}`,
                "v".repeat(100),
              ]),
            ),
            subject: "s".repeat(256),
            tags: [
              { name: "tag0", value: "v".repeat(95) },
              ...Array.from({ length: 4 }, (_, index) => ({
                name: `tag${index + 1}`,
                value: "v".repeat(95),
              })),
            ],
            to: [
              "first@example.test",
              ...Array.from({ length: 49 }, (_, index) => `recipient${index}@example.test`),
            ],
          });
        }).pipe(Effect.provide(fixtureHeloLayer(fixture)));

        assert(EmailReceiptSchema.guards.Accepted(receipt));

        const wire = yield* Schema.decodeEffect(
          Schema.fromJsonString(
            Schema.Struct({
              headers: Schema.Record(Schema.String, Schema.String),
              metadata: Schema.Record(Schema.String, Schema.String),
              subject: Schema.String,
              tags: Schema.Array(Schema.String),
              to: Schema.Array(Schema.Struct({ email: Schema.String })),
            }),
          ),
        )((yield* Queue.take(fixture.received)).body);

        assert.strictEqual(wire.to.length, 50);
        assert.strictEqual(wire.to[49]?.email, "recipient48@example.test");
        assert.strictEqual(wire.subject, "s".repeat(256));
        assert.strictEqual(wire.tags.length, 5);
        assert.strictEqual(wire.tags[4], `tag4:${"v".repeat(95)}`);
        assert.strictEqual(Object.keys(wire.metadata).length, 10);
        assert.strictEqual(wire.metadata[`${"m".repeat(49)}9`], "v".repeat(100));
        assert.strictEqual(Object.keys(wire.headers).length, 5);
        assert.strictEqual(wire.headers["X-A4"], "x".repeat(996));
      }),
  );

  it.live.each([
    { ...message, subject: "x".repeat(257) },
    { ...message, sendAt: "2026-10-14T12:30:00Z" },
    { ...message, cc: "FIRST@example.test" },
    { ...message, tags: [{ name: "private:name", value: "value" }] },
    { ...message, tags: [{ name: "workflow", value: "x".repeat(92) }] },
    {
      ...message,
      tags: [
        { name: "tag", value: "value" },
        ...Array.from({ length: 5 }, (_, index) => ({ name: `tag${index}`, value: "value" })),
      ],
    },
    { ...message, metadata: { workflow: "private".repeat(20) } },
    { ...message, metadata: { ["x".repeat(51)]: "private-value" } },
    {
      ...message,
      metadata: Object.fromEntries(
        Array.from({ length: 11 }, (_, index) => [`field${index}`, "value"]),
      ),
    },
    { ...message, headers: [{ name: "X-Helo-Channel-Id", value: "private-value" }] },
    { ...message, headers: [{ name: "X-Helo-Idempotency-Key", value: "private-value" }] },
    {
      ...message,
      headers: [
        { name: "X-Field", value: "x".repeat(900) },
        ...Array.from({ length: 5 }, (_, index) => ({
          name: `X-Field-${index}`,
          value: "x".repeat(900),
        })),
      ],
    },
    {
      ...message,
      headers: [
        { name: "X-Workflow", value: "first" },
        { name: "x-workflow", value: "second" },
      ],
    },
  ] as const)("rejects nonrepresentable intent before HTTP (%j)", (input) =>
    Effect.gen(function* rejectHeloIntent() {
      const fixture = yield* startEmailHttpFixture({
        body: JSON.stringify(acknowledgement),
        status: 200,
      });

      const outcome = yield* Effect.gen(function* submitInvalidHeloIntent() {
        return yield* (yield* Email).send(input);
      }).pipe(Effect.provide(fixtureHeloLayer(fixture)), Effect.result);

      assert(Result.isFailure(outcome) && outcome.failure instanceof EmailInvalidMessage);
      assert.notInclude(JSON.stringify(outcome.failure), "private");
      assert.strictEqual(yield* Queue.size(fixture.received), 0);
    }),
  );

  it.live.each(["", "private token", "private\ncredential"])(
    "rejects invalid credentials locally without disclosure (%j)",
    (apiKey) =>
      Effect.gen(function* rejectHeloCredentials() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 200,
        });

        const outcome = yield* Effect.gen(function* submitHeloCredentials() {
          return yield* (yield* Email).send(message);
        }).pipe(
          Effect.provide(
            heloEmailLayer({ ...options, apiKey: Redacted.make(apiKey) }).pipe(
              Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.helohq.com")),
            ),
          ),
          Effect.result,
        );

        assert(Result.isFailure(outcome) && outcome.failure instanceof EmailConfigurationError);
        assert.notInclude(JSON.stringify(outcome.failure), "private");
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );

  it.live(
    "requires explicit channel mode and a valid channel UUID but permits channel-scoped credentials",
    () =>
      Effect.gen(function* validateHeloChannelSelection() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 200,
        });

        // @ts-expect-error -- Untyped callers must not bypass the required mode declaration.
        const missingMode = heloEmailLayer({ apiKey: options.apiKey });
        const invalidChannel = heloEmailLayer({ ...options, channelId: "private-invalid-channel" });

        for (const layer of [missingMode, invalidChannel]) {
          const outcome = yield* Effect.gen(function* submitInvalidChannel() {
            return yield* (yield* Email).send(message);
          }).pipe(
            Effect.provide(
              layer.pipe(
                Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.helohq.com")),
              ),
            ),
            Effect.result,
          );

          assert(Result.isFailure(outcome) && outcome.failure instanceof EmailConfigurationError);
          assert.notInclude(JSON.stringify(outcome.failure), "private");
        }

        assert.strictEqual(yield* Queue.size(fixture.received), 0);

        const receipt = yield* Effect.gen(function* submitChannelScopedCredential() {
          return yield* (yield* Email).send(message);
        }).pipe(
          Effect.provide(
            heloEmailLayer({ apiKey: options.apiKey, channelMode: "Live" }, policy).pipe(
              Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.helohq.com")),
            ),
          ),
        );

        assert(EmailReceiptSchema.guards.Accepted(receipt));
        const sent = yield* Queue.take(fixture.received);
        assert.strictEqual(sent.heloChannelId, "");
        assert.strictEqual(sent.heloIdempotencyKey, "");
      }),
  );

  it.live.each([
    {
      body: { errorCode: "validation_failed", status: "failed" },
      reason: "invalid-message",
      status: 200,
    },
    {
      body: { errorCode: "send_limit_exceeded", status: "failed" },
      reason: "rejected",
      status: 200,
    },
    {
      body: { code: "validation_failed", detail: "private-reason" },
      reason: "invalid-message",
      status: 422,
    },
    {
      body: { code: "send_limit_exceeded", detail: "private-reason" },
      reason: "rejected",
      status: 422,
    },
    { body: {}, reason: "authentication", status: 401 },
    { body: {}, reason: "rejected", status: 403 },
  ])("advances only after definite $reason evidence at $status", (scenario) =>
    Effect.gen(function* fallBackAfterHeloRejection() {
      const primary = yield* startEmailHttpFixture({
        body: JSON.stringify(scenario.body),
        status: scenario.status,
      });

      const backup = yield* startEmailHttpFixture({
        body: JSON.stringify({ id: "backup-id" }),
        status: 200,
      });

      const rejected = yield* Effect.gen(function* inspectHeloRejection() {
        return yield* (yield* Email).send(message);
      }).pipe(Effect.provide(fixtureHeloLayer(primary)), Effect.result);

      assert(Result.isFailure(rejected) && rejected.failure instanceof EmailRejected);
      assert.strictEqual(rejected.failure.reason, scenario.reason);
      assert.notInclude(JSON.stringify(rejected.failure), "private");
      const receipt = yield* sendHeloRoute.pipe(Effect.provide(fixtureHeloRoute(primary, backup)));
      assert(EmailReceiptSchema.guards.Accepted(receipt));
      assert.strictEqual(receipt.route, "backup");
      assert.strictEqual(yield* Queue.size(backup.received), 1);
    }),
  );

  it.live.each([
    { body: { code: "recipients_suppressed", messageId }, status: 422 },
    { body: { code: "recipients_suppressed", suppressions: [message.to[0]] }, status: 422 },
    { body: { code: "recipients_suppressed", status: 400 }, status: 422 },
    { body: { code: "unknown", detail: "private-reason" }, status: 422 },
    { body: {}, status: 422 },
    { body: { code: "unknown-conflict", detail: "private-reason" }, status: 409 },
    { body: acknowledgement, status: 201 },
  ])("does not reinterpret unsafe error/status evidence as non-submission (%j)", (scenario) =>
    Effect.gen(function* stopUncertainHeloRoute() {
      const primary = yield* startEmailHttpFixture({
        body: JSON.stringify(scenario.body),
        status: scenario.status,
      });

      const backup = yield* startEmailHttpFixture({
        body: JSON.stringify({ id: "backup-id" }),
        status: 200,
      });

      const outcome = yield* sendHeloRoute.pipe(
        Effect.provide(fixtureHeloRoute(primary, backup, 3)),
        Effect.result,
      );

      assert(Result.isFailure(outcome) && outcome.failure instanceof EmailDeliveryUnknown);
      assert.notInclude(JSON.stringify(outcome.failure), "private");
      assert.strictEqual(yield* Queue.size(primary.received), 1);
      assert.strictEqual(yield* Queue.size(backup.received), 0);
    }),
  );

  it.effect(
    "replays keyed server uncertainty with identical owned intent at the same channel",
    () =>
      Effect.gen(function* replayHeloNativeSubmission() {
        const primary = yield* startEmailHttpFixture({
          body: "private-server-reason",
          next: { body: JSON.stringify(acknowledgement), status: 200 },
          status: 503,
        });

        const backup = yield* startEmailHttpFixture({
          body: JSON.stringify({ id: "backup-id" }),
          status: 200,
        });

        const input: Omit<typeof message, "subject"> & { subject: string } = { ...message };

        const fiber = yield* Effect.gen(function* submitOwnedHeloIntent() {
          return yield* (yield* (yield* EmailRouter).select()).send(input, {
            idempotencyKey: "synthetic-stable-key",
          });
        }).pipe(Effect.provide(fixtureHeloRoute(primary, backup, 3)), Effect.forkScoped);

        const first = yield* Queue.take(primary.received);
        input.subject = "private-mutated-subject";
        yield* TestClock.adjust(1000);
        const receipt = yield* Fiber.join(fiber);
        const replay = yield* Queue.take(primary.received);
        assert(EmailReceiptSchema.guards.Accepted(receipt));
        assert.strictEqual(receipt.route, "primary");
        assert.strictEqual(replay.body, first.body);
        assert.strictEqual(replay.heloIdempotencyKey, "synthetic-stable-key");
        assert.strictEqual(replay.heloIdempotencyKey, first.heloIdempotencyKey);
        assert.strictEqual(replay.heloChannelId, first.heloChannelId);
        assert.notInclude(replay.body, "private-mutated");
        assert.strictEqual(yield* Queue.size(backup.received), 0);
      }),
  );

  it.live("does not replay unkeyed server uncertainty", () =>
    Effect.gen(function* stopUnkeyedHeloReplay() {
      const fixture = yield* startEmailHttpFixture({ body: "private-server-reason", status: 503 });

      const outcome = yield* Effect.gen(function* submitUnkeyedHeloMessage() {
        return yield* (yield* Email).send(message);
      }).pipe(Effect.provide(fixtureHeloLayer(fixture, 3)), Effect.result);

      assert(Result.isFailure(outcome) && outcome.failure instanceof EmailDeliveryUnknown);
      assert.strictEqual(outcome.failure.reason, "server-error");
      assert.strictEqual(yield* Queue.size(fixture.received), 1);
    }),
  );

  it.effect("retries rejected endpoint rate limits under virtual time but not account quotas", () =>
    Effect.gen(function* distinguishHeloRateAndQuota() {
      const endpoint = yield* startEmailHttpFixture({
        body: "{}",
        next: { body: JSON.stringify(acknowledgement), status: 200 },
        retryAfter: "2",
        status: 429,
      });

      const fiber = yield* Effect.gen(function* submitRateLimitedHeloMessage() {
        return yield* (yield* Email).send(message);
      }).pipe(Effect.provide(fixtureHeloLayer(endpoint, 3)), Effect.forkScoped);

      yield* Queue.take(endpoint.received);
      yield* TestClock.adjust(1000);
      assert.strictEqual(yield* Queue.size(endpoint.received), 0);
      yield* TestClock.adjust(1000);
      assert(EmailReceiptSchema.guards.Accepted(yield* Fiber.join(fiber)));
      assert.strictEqual(yield* Queue.size(endpoint.received), 1);

      for (const code of ["send_limit_exceeded", "resource_limit_exceeded"]) {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify({ code, detail: "private-quota-reason" }),
          status: 429,
        });

        const outcome = yield* Effect.gen(function* submitHeloQuota() {
          return yield* (yield* Email).send(message);
        }).pipe(Effect.provide(fixtureHeloLayer(fixture, 3)), Effect.result);

        assert(Result.isFailure(outcome) && outcome.failure instanceof EmailRejected);
        assert.strictEqual(outcome.failure.reason, "rejected");
        assert.strictEqual(yield* Queue.size(fixture.received), 1);
      }
    }),
  );

  it.live(
    "rejects deadlines at the one-hour replay window before acquisition or per-operation HTTP",
    () =>
      Effect.gen(function* enforceHeloRetention() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 200,
        });

        const unsafe = { ...policy, deadline: Duration.hours(1), maxAttempts: 2 };

        const acquisition = yield* Effect.gen(function* acquireUnsafeHeloPolicy() {
          return yield* (yield* Email).send(message);
        }).pipe(
          Effect.provide(
            heloEmailLayer(options, unsafe).pipe(
              Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.helohq.com")),
            ),
          ),
          Effect.result,
        );

        assert(
          Result.isFailure(acquisition) && acquisition.failure instanceof EmailConfigurationError,
        );
        yield* Effect.gen(function* rejectUnsafeHeloOverride() {
          const email = yield* Email;

          const invalid = yield* email
            .send(message, { idempotencyKey: "synthetic-key", policy: unsafe })
            .pipe(Effect.result);

          assert(Result.isFailure(invalid) && invalid.failure instanceof EmailInvalidOptions);
          assert.strictEqual(yield* Queue.size(fixture.received), 0);

          const receipt = yield* email.send(message, {
            idempotencyKey: "synthetic-key",
            policy: { ...unsafe, maxAttempts: 1 },
          });

          assert(EmailReceiptSchema.guards.Accepted(receipt));
        }).pipe(Effect.provide(fixtureHeloLayer(fixture)));
      }),
  );

  it.live(
    "bounds unchanged native keys and preflights stricter backup keys before primary HTTP",
    () =>
      Effect.gen(function* enforceHeloKeyAuthority() {
        const primary = yield* startEmailHttpFixture({
          body: JSON.stringify({ id: "resend-id" }),
          status: 200,
        });

        const backup = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 200,
        });

        const outcome = yield* Effect.gen(function* submitKeyLimitedRoute() {
          return yield* (yield* (yield* EmailRouter).select()).send(message, {
            idempotencyKey: "k".repeat(37),
          });
        }).pipe(
          Effect.provide(
            emailRouterLayer(
              [
                {
                  layer: resendEmailLayer({ apiKey: options.apiKey }, policy).pipe(
                    Layer.provide(emailFixtureClientLayer(primary.url, "https://api.resend.com")),
                  ),
                  name: "primary",
                },
                { layer: fixtureHeloLayer(backup), name: "backup" },
              ],
              { fallbacks: ["backup"], primary: "primary" },
            ),
          ),
          Effect.result,
        );

        assert(Result.isFailure(outcome) && outcome.failure instanceof EmailRejected);
        assert.strictEqual(outcome.failure.reason, "unsupported-idempotency");
        assert.strictEqual(yield* Queue.size(primary.received), 0);
        assert.strictEqual(yield* Queue.size(backup.received), 0);

        const receipt = yield* Effect.gen(function* submitMaxHeloKey() {
          return yield* (yield* Email).send(message, { idempotencyKey: "k".repeat(36) });
        }).pipe(Effect.provide(fixtureHeloLayer(backup)));

        assert(EmailReceiptSchema.guards.Accepted(receipt));
        assert.strictEqual((yield* Queue.take(backup.received)).heloIdempotencyKey, "k".repeat(36));
      }),
  );
});
