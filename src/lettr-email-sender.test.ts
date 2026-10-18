import { assert, describe, it } from "@effect/vitest";
import {
  DateTime,
  Duration,
  Effect,
  Fiber,
  Layer,
  Queue,
  Redacted,
  Result,
  Schema,
  Tracer,
} from "effect";
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
  EmailSender,
  parseEmailMessage,
  EmailIdempotencyKeySchema,
  EmailSenderIdempotencySchema,
} from "./index.js";
import { lettrEmailLayer, lettrSenderLayer } from "./lettr-email-sender.js";
import type { LettrEmailOptions } from "./lettr-email-sender.js";
import { resendEmailLayer } from "./resend-email-sender.js";

const message = {
  body: { html: "<p>Synthetic {{literal}}</p>", text: "Synthetic {{literal}}" },
  from: { address: "sender@example.test", name: "Fictional Café" },
  subject: "Synthetic Lettr notification",
  to: ["First@example.test"],
} as const;

const options = {
  apiKey: Redacted.make("lttr_fictional-live-key"),
  submissionMode: "Immediate",
} as const;

const policy = {
  deadline: Duration.seconds(5),
  initialDelay: Duration.millis(100),
  maxAttempts: 1,
};

const acknowledgement = {
  data: { accepted: 1, rejected: 0, request_id: "private-transmission-id" },
  message: "private-confirmation",
};

const scheduledClockMillis = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-14T12:00:00Z"));

const scheduled = { ...message, sendAt: "2026-10-14T12:30:00.123Z" } as const;

const scheduledAcknowledgement = {
  data: {
    accepted: 1,
    failure_reason: null,
    num_recipients: 1,
    recipients: ["first@example.test"],
    rejected: 0,
    request_id: "sch_01JQZ3N2K8XW9V6M4TBRC7YHDE",
    scheduled_at: "2026-10-14T12:30:00.123+00:00",
    state: "scheduled",
    transmission_id: null,
  },
  message: "private-schedule-confirmation",
};

const fixtureLettrLayer = (
  fixture: EmailHttpFixture,
  maxAttempts = 1,
  submissionMode: LettrEmailOptions["submissionMode"] = "Immediate",
) =>
  lettrEmailLayer({ ...options, submissionMode }, { ...policy, maxAttempts }).pipe(
    Layer.provide(emailFixtureClientLayer(fixture.url, "https://app.lettr.com")),
  );

const fixtureLettrRoute = (primary: EmailHttpFixture, backup: EmailHttpFixture, maxAttempts = 1) =>
  emailRouterLayer(
    [
      { layer: fixtureLettrLayer(primary, maxAttempts), name: "primary" },
      {
        layer: resendEmailLayer({ apiKey: Redacted.make("fictional-backup-key") }, policy).pipe(
          Layer.provide(emailFixtureClientLayer(backup.url, "https://api.resend.com")),
        ),
        name: "backup",
      },
    ],
    { fallbacks: ["backup"], primary: "primary" },
  );

const sendLettrRoute = Effect.gen(function* submitLettrRoute() {
  return yield* (yield* (yield* EmailRouter).select()).send(message, {
    idempotencyKey: "synthetic-key",
  });
});

describe("Lettr actual immediate and scheduled protocols", () => {
  it.live(
    "preserves rich structured fields and explicit MIME without tracking, substitutions or unsubscribe bypass",
    () =>
      Effect.gen(function* inspectLettrWire() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify({
            ...acknowledgement,
            data: { ...acknowledgement.data, accepted: 3 },
          }),
          status: 200,
        });

        const receipt = yield* Effect.gen(function* submitRichLettrMessage() {
          const attachment = yield* emailAttachmentFromBytes(new Uint8Array([0, 255, 128, 10]), {
            contentType: "application/octet-stream",
            filename: "sample.dat",
          });

          return yield* (yield* Email).send(
            {
              ...message,
              attachments: [attachment],
              bcc: "hidden@example.test",
              cc: "copy@example.test",
              headers: [{ name: "X-Workflow", value: "synthetic-value" }],
              metadata: {
                idempotency_key: "metadata-is-not-replay-authority",
                workflow: "synthetic",
              },
              replyTo: { address: "reply@example.test", name: "Fictional Reply" },
              tags: [{ name: "purpose", value: "café" }],
            },
            { idempotencyKey: "synthetic-key" },
          );
        }).pipe(Effect.provide(fixtureLettrLayer(fixture)));

        assert(EmailReceiptSchema.guards.Accepted(receipt));
        assert.strictEqual(receipt.messageId, acknowledgement.data.request_id);
        assert.isTrue(Object.isFrozen(receipt));
        assert.notInclude(JSON.stringify(receipt), "private-confirmation");
        const sent = yield* Queue.take(fixture.received);
        assert.strictEqual(sent.method, "POST");
        assert.strictEqual(sent.path, "/api/emails");
        assert.strictEqual(sent.authorization, "Bearer lttr_fictional-live-key");
        assert.strictEqual(sent.idempotencyKey, "synthetic-key");

        const wire = yield* Schema.decodeEffect(
          Schema.fromJsonString(
            Schema.Struct({
              attachments: Schema.Array(
                Schema.Struct({ data: Schema.String, name: Schema.String, type: Schema.String }),
              ),
              bcc: Schema.Array(Schema.String),
              cc: Schema.Array(Schema.String),
              from: Schema.String,
              from_name: Schema.String,
              headers: Schema.Record(Schema.String, Schema.String),
              html: Schema.String,
              metadata: Schema.Record(Schema.String, Schema.String),
              options: Schema.Struct({
                click_tracking: Schema.Boolean,
                inline_css: Schema.Boolean,
                open_tracking: Schema.Boolean,
                perform_substitutions: Schema.Boolean,
                transactional: Schema.Boolean,
              }),
              reply_to: Schema.String,
              reply_to_name: Schema.String,
              subject: Schema.String,
              tag: Schema.String,
              text: Schema.String,
              to: Schema.Array(Schema.String),
            }),
          ),
        )(sent.body);

        assert.strictEqual(wire.from, "sender@example.test");
        assert.strictEqual(wire.from_name, "Fictional Café");
        assert.deepStrictEqual(wire.to, [...message.to]);
        assert.deepStrictEqual(wire.cc, ["copy@example.test"]);
        assert.deepStrictEqual(wire.bcc, ["hidden@example.test"]);
        assert.strictEqual(wire.reply_to, "reply@example.test");
        assert.strictEqual(wire.reply_to_name, "Fictional Reply");
        assert.strictEqual(wire.subject, message.subject);
        assert.strictEqual(wire.text, message.body.text);
        assert.strictEqual(wire.html, message.body.html);
        assert.strictEqual(wire.headers["X-Workflow"], "synthetic-value");
        assert.strictEqual(wire.tag, "purpose:café");
        assert.strictEqual(wire.metadata.workflow, "synthetic");
        assert.strictEqual(wire.metadata.idempotency_key, "metadata-is-not-replay-authority");
        assert.isFalse(wire.options.open_tracking);
        assert.isFalse(wire.options.click_tracking);
        assert.isFalse(wire.options.inline_css);
        assert.isFalse(wire.options.perform_substitutions);
        assert.isFalse(wire.options.transactional);
        const [attachment] = wire.attachments;
        assert.isDefined(attachment);
        assert.strictEqual(attachment.type, "application/octet-stream");
        assert.strictEqual(attachment.name, "sample.dat");
        assert.deepStrictEqual([...Buffer.from(attachment.data, "base64")], [0, 255, 128, 10]);
        assert.notInclude(sent.body, '"scheduled_at"');
        assert.notInclude(sent.body, '"template_slug"');
      }),
  );

  it.effect.each([
    { accepted: 0, total: 1 },
    { accepted: 1, total: 1 },
    { accepted: 1, total: 2 },
    { accepted: 0, total: 50 },
    { accepted: 25, total: 50 },
    { accepted: 50, total: 50 },
  ])(
    "retains $accepted/$total accepted recipients without inventing identities or advancing backup",
    ({ accepted, total }) =>
      Effect.gen(function* preserveCountedLettrOutcomes() {
        const primary = yield* startEmailHttpFixture({
          body: JSON.stringify({
            data: { accepted, rejected: total - accepted, request_id: "private-counted-id" },
            message: "private-counted-confirmation",
          }),
          status: 200,
        });

        const backup = yield* startEmailHttpFixture({
          body: JSON.stringify({ id: "backup-id" }),
          status: 200,
        });

        const trace = yield* startEmailTraceFixture();

        const recipients: readonly [string, ...string[]] = [
          "FIRST@example.test",
          ...Array.from({ length: total - 1 }, (_, index) => `recipient-${index}@example.test`),
        ];

        const receipt = yield* Effect.gen(function* submitCountedRoute() {
          return yield* (yield* (yield* EmailRouter).select()).send({ ...message, to: recipients });
        }).pipe(
          Effect.provide(fixtureLettrRoute(primary, backup, 3)),
          Effect.provideService(Tracer.Tracer, trace.tracer),
        );

        assert.strictEqual(receipt.route, "primary");
        assert.isTrue(Object.isFrozen(receipt));

        if (accepted === total) {
          assert(EmailReceiptSchema.guards.Accepted(receipt));
        } else if (accepted === 0) {
          assert(EmailReceiptSchema.guards.RecipientsRejected(receipt));
          assert.deepStrictEqual(receipt.rejected.map(String), [...recipients]);
          assert.isTrue(Object.isFrozen(receipt.rejected));
          assert.notProperty(receipt, "suppressed");
        } else {
          assert(EmailReceiptSchema.guards.PartiallyAcceptedCounts(receipt));
          assert.strictEqual(receipt.counts.acceptedCount, accepted);
          assert.strictEqual(receipt.counts.rejectedCount, total - accepted);
          assert.isTrue(Object.isFrozen(receipt.counts));
          assert.notProperty(receipt, "accepted");
          assert.notProperty(receipt, "rejected");
          assert.notProperty(receipt, "suppressed");
        }

        assert.strictEqual(receipt.messageId, "private-counted-id");
        assert.strictEqual(yield* Queue.size(primary.received), 1);
        assert.strictEqual(yield* Queue.size(backup.received), 0);
        const diagnostics = yield* trace.diagnostics;
        assert.notInclude(diagnostics, "private-");
        assert.notInclude(diagnostics, "example.test");
        assert.notInclude(diagnostics, "acceptedCount");
      }),
  );

  it.live.each([
    {},
    { data: { accepted: 1, rejected: 0 } },
    { data: { ...acknowledgement.data, request_id: "invalid id" } },
    { data: { ...acknowledgement.data, accepted: "1" } },
    { data: { ...acknowledgement.data, accepted: -1 } },
    { data: { ...acknowledgement.data, accepted: 0.5 } },
    { data: { ...acknowledgement.data, accepted: 0 } },
    { data: { ...acknowledgement.data, accepted: 2 } },
    { data: { ...acknowledgement.data, rejected: 1 } },
    { ...acknowledgement, error_code: "private-error" },
  ])("keeps missing, invalid or inconsistent count acknowledgement uncertain (%j)", (body) =>
    Effect.gen(function* rejectUnprovenLettrCounts() {
      const primary = yield* startEmailHttpFixture({ body: JSON.stringify(body), status: 200 });

      const backup = yield* startEmailHttpFixture({
        body: JSON.stringify({ id: "backup-id" }),
        status: 200,
      });

      const outcome = yield* sendLettrRoute.pipe(
        Effect.provide(fixtureLettrRoute(primary, backup, 3)),
        Effect.result,
      );

      assert(Result.isFailure(outcome) && outcome.failure instanceof EmailDeliveryUnknown);
      assert.strictEqual(outcome.failure.reason, "invalid-response");
      assert.notInclude(JSON.stringify(outcome.failure), "private-");
      assert.strictEqual(yield* Queue.size(primary.received), 1);
      assert.strictEqual(yield* Queue.size(backup.received), 0);
    }),
  );

  it.effect(
    "acknowledges exact millisecond scheduling as a Lettr hold, not an upstream transmission",
    () =>
      Effect.gen(function* inspectLettrScheduledWire() {
        yield* TestClock.setTime(scheduledClockMillis);

        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify(scheduledAcknowledgement),
          status: 201,
        });

        const receipt = yield* Effect.gen(function* submitLettrSchedule() {
          return yield* (yield* Email).send(scheduled);
        }).pipe(Effect.provide(fixtureLettrLayer(fixture, 3, "Scheduled")));

        assert(EmailReceiptSchema.guards.Accepted(receipt));
        assert.strictEqual(receipt.messageId, scheduledAcknowledgement.data.request_id);
        assert.notInclude(JSON.stringify(receipt), "private-");
        const sent = yield* Queue.take(fixture.received);
        assert.strictEqual(sent.path, "/api/emails/scheduled");
        assert.strictEqual(sent.idempotencyKey, "");

        const wire = yield* Schema.decodeEffect(
          Schema.fromJsonString(Schema.Struct({ scheduled_at: Schema.String })),
        )(sent.body);

        assert.strictEqual(wire.scheduled_at, "2026-10-14T12:30:00.123Z");
      }),
  );

  it.effect.each([
    { ...scheduledAcknowledgement.data, scheduled_at: "2026-10-14T12:30:00Z" },
    { ...scheduledAcknowledgement.data, scheduled_at: "2026-02-30T12:30:00.123Z" },
    { ...scheduledAcknowledgement.data, request_id: "upstream-transmission" },
    { ...scheduledAcknowledgement.data, transmission_id: "already-injected" },
    { ...scheduledAcknowledgement.data, state: "sent" },
    { ...scheduledAcknowledgement.data, failure_reason: "private-failure" },
    { ...scheduledAcknowledgement.data, recipients: ["foreign@example.test"] },
    { ...scheduledAcknowledgement.data, recipients: ["first@example.test", "FIRST@example.test"] },
    { ...scheduledAcknowledgement.data, num_recipients: 2 },
    { ...scheduledAcknowledgement.data, rejected: 1 },
  ])("keeps rewritten or inconsistent scheduled evidence unknown (%j)", (data) =>
    Effect.gen(function* rejectUnprovenLettrSchedule() {
      yield* TestClock.setTime(scheduledClockMillis);
      const fixture = yield* startEmailHttpFixture({ body: JSON.stringify({ data }), status: 201 });

      const outcome = yield* Effect.gen(function* submitUnprovenHold() {
        return yield* (yield* Email).send(scheduled);
      }).pipe(Effect.provide(fixtureLettrLayer(fixture, 3, "Scheduled")), Effect.result);

      assert(Result.isFailure(outcome) && outcome.failure instanceof EmailDeliveryUnknown);
      assert.strictEqual(outcome.failure.reason, "invalid-response");
      assert.notInclude(JSON.stringify(outcome.failure), "private-");
      assert.strictEqual(yield* Queue.size(fixture.received), 1);
    }),
  );

  it.live.each([
    { ...message, to: { address: "recipient@example.test", name: "Fictional Recipient" } },
    { ...message, cc: { address: "copy@example.test", name: "Fictional Copy" } },
    { ...message, bcc: { address: "hidden@example.test", name: "Fictional Hidden" } },
    { ...message, cc: "first@example.test" },
    { ...message, from: { address: "sender@example.test", name: "n".repeat(256) } },
    { ...message, replyTo: ["reply@example.test", "other@example.test"] },
    { ...message, replyTo: { address: "reply@example.test", name: "n".repeat(256) } },
    { ...message, tags: [{ name: "purpose:conflicting", value: "value" }] },
    { ...message, tags: [{ name: "p", value: "v".repeat(63) }] },
    {
      ...message,
      tags: [
        { name: "p", value: "first" },
        { name: "q", value: "second" },
      ],
    },
    {
      ...message,
      headers: [
        { name: "X-Header-First", value: "value" },
        ...Array.from({ length: 10 }, (_, index) => ({
          name: `X-Header-${index}`,
          value: "value",
        })),
      ],
    },
    ...[
      "Message-ID",
      "List-Unsubscribe",
      "List-Unsubscribe-Post",
      "X-MSYS-API",
      "X-Lettr-Track-Opens",
    ].map((name) => ({ ...message, headers: [{ name, value: "private-value" }] as const })),
    {
      ...message,
      attachments: [
        { contentBase64: "AQ==", contentType: "ProviderSelected", filename: "sample.dat" },
      ],
    },
    {
      ...message,
      attachments: [
        {
          contentBase64: "AQ==",
          contentId: "sample-cid",
          contentType: "image/png",
          filename: "sample.png",
        },
      ],
    },
    scheduled,
  ] as const)(
    "rejects intent that cannot be preserved in immediate sending before HTTP (%j)",
    (input) =>
      Effect.gen(function* rejectLettrIntent() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 200,
        });

        const outcome = yield* Effect.gen(function* submitUnsupportedLettrIntent() {
          return yield* (yield* Email).send(input);
        }).pipe(Effect.provide(fixtureLettrLayer(fixture)), Effect.result);

        assert(Result.isFailure(outcome) && outcome.failure instanceof EmailInvalidMessage);
        assert.notInclude(JSON.stringify(outcome.failure), "private-");
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );

  it.effect("requires a schedule in scheduled mode and never silently discards a key", () =>
    Effect.gen(function* rejectWrongLettrAuthority() {
      yield* TestClock.setTime(scheduledClockMillis);

      const fixture = yield* startEmailHttpFixture({
        body: JSON.stringify(scheduledAcknowledgement),
        status: 201,
      });

      yield* Effect.gen(function* inspectSchedulePreflight() {
        const email = yield* Email;
        const unscheduled = yield* email.send(message).pipe(Effect.result);
        assert(Result.isFailure(unscheduled) && unscheduled.failure instanceof EmailInvalidMessage);

        const keyed = yield* email
          .send(scheduled, { idempotencyKey: "synthetic-key" })
          .pipe(Effect.result);

        assert(Result.isFailure(keyed) && keyed.failure instanceof EmailRejected);
        assert.strictEqual(keyed.failure.reason, "unsupported-idempotency");
      }).pipe(Effect.provide(fixtureLettrLayer(fixture, 3, "Scheduled")));

      const direct = yield* Effect.gen(function* defendDirectScheduledSubmission() {
        return yield* (yield* EmailSender).submit({
          idempotencyKey: yield* Schema.decodeEffect(EmailIdempotencyKeySchema)("synthetic-key"),
          message: yield* parseEmailMessage(scheduled),
        });
      }).pipe(
        Effect.provide(
          lettrSenderLayer({ ...options, submissionMode: "Scheduled" }).pipe(
            Layer.provide(emailFixtureClientLayer(fixture.url, "https://app.lettr.com")),
          ),
        ),
        Effect.result,
      );

      assert(Result.isFailure(direct) && direct.failure instanceof EmailRejected);
      assert.strictEqual(direct.failure.reason, "unsupported-idempotency");
      assert.strictEqual(yield* Queue.size(fixture.received), 0);
    }),
  );

  it.live.each(["synthetic/key", "synthetic:key", "k".repeat(256)])(
    "preflights key format and size across real routes before primary HTTP (%s)",
    (idempotencyKey) =>
      Effect.gen(function* preflightLettrBackupKey() {
        const primary = yield* startEmailHttpFixture({
          body: JSON.stringify({ id: "resend-id" }),
          status: 200,
        });

        const backup = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 200,
        });

        const route = emailRouterLayer(
          [
            {
              layer: resendEmailLayer({ apiKey: Redacted.make("fictional-key") }, policy).pipe(
                Layer.provide(emailFixtureClientLayer(primary.url, "https://api.resend.com")),
              ),
              name: "primary",
            },
            { layer: fixtureLettrLayer(backup), name: "backup" },
          ],
          { fallbacks: ["backup"], primary: "primary" },
        );

        const outcome = yield* Effect.gen(function* submitIncompatibleKeyRoute() {
          return yield* (yield* (yield* EmailRouter).select()).send(message, { idempotencyKey });
        }).pipe(Effect.provide(route), Effect.result);

        assert(Result.isFailure(outcome) && outcome.failure instanceof EmailRejected);
        assert.strictEqual(outcome.failure.reason, "unsupported-idempotency");
        assert.strictEqual(yield* Queue.size(primary.received), 0);
        assert.strictEqual(yield* Queue.size(backup.received), 0);
      }),
  );

  it.live(
    "forwards the full 255-character native key and directly defends character constraints",
    () =>
      Effect.gen(function* defendLettrNativeKey() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 200,
        });

        const outcome = yield* Effect.gen(function* submitMaximumLettrKey() {
          return yield* (yield* Email).send(message, { idempotencyKey: "k".repeat(255) });
        }).pipe(Effect.provide(fixtureLettrLayer(fixture)));

        assert(EmailReceiptSchema.guards.Accepted(outcome));
        assert.strictEqual((yield* Queue.take(fixture.received)).idempotencyKey, "k".repeat(255));

        const direct = yield* Effect.gen(function* submitUnsupportedDirectKey() {
          return yield* (yield* EmailSender).submit({
            idempotencyKey: yield* Schema.decodeEffect(EmailIdempotencyKeySchema)("synthetic/key"),
            message: yield* parseEmailMessage(message),
          });
        }).pipe(
          Effect.provide(
            lettrSenderLayer(options).pipe(
              Layer.provide(emailFixtureClientLayer(fixture.url, "https://app.lettr.com")),
            ),
          ),
          Effect.result,
        );

        assert(Result.isFailure(direct) && direct.failure instanceof EmailRejected);
        assert.strictEqual(direct.failure.reason, "unsupported-idempotency");
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );

  it.effect.each([
    { body: "private-gateway-error", key: "synthetic-key", status: 502 },
    {
      body: JSON.stringify({
        error_code: "idempotency_in_progress",
        message: "private-processing",
      }),
      key: "synthetic-key",
      status: 409,
    },
    {
      body: JSON.stringify({ error_code: "rate_limit_exceeded", message: "private-rate" }),
      key: undefined,
      status: 429,
    },
    {
      body: JSON.stringify({ error_code: "auth_unavailable", message: "private-authentication" }),
      key: undefined,
      status: 503,
    },
  ])(
    "retains exact owned payload/key and safe minimum delay for $status",
    ({ body, key, status }) =>
      Effect.gen(function* retryAuthorizedLettrOutcome() {
        const fixture = yield* startEmailHttpFixture({
          body,
          next: { body: JSON.stringify(acknowledgement), status: 200 },
          retryAfter: "2",
          status,
        });

        const input: Omit<typeof message, "subject"> & { subject: string } = { ...message };

        const fiber = yield* Effect.gen(function* submitRetryableLettrIntent() {
          const email = yield* Email;

          return yield* key === undefined
            ? email.send(input)
            : email.send(input, { idempotencyKey: key });
        }).pipe(Effect.provide(fixtureLettrLayer(fixture, 3)), Effect.forkScoped);

        const first = yield* Queue.take(fixture.received);
        input.subject = "private-mutated-subject";

        if (status !== 502) {
          yield* TestClock.adjust(1000);
          assert.strictEqual(yield* Queue.size(fixture.received), 0);
        }

        yield* TestClock.adjust(2000);
        assert(EmailReceiptSchema.guards.Accepted(yield* Fiber.join(fiber)));
        const retry = yield* Queue.take(fixture.received);
        assert.strictEqual(retry.body, first.body);
        assert.strictEqual(retry.idempotencyKey, key ?? "");
        assert.strictEqual(retry.idempotencyKey, first.idempotencyKey);
        assert.notInclude(retry.body, "private-mutated");
      }),
  );

  it.live.each([
    { body: "private-server", reason: "server-error", status: 502 },
    {
      body: JSON.stringify({ error_code: "idempotency_in_progress" }),
      reason: "idempotency-in-progress",
      status: 409,
    },
    {
      body: JSON.stringify({ error_code: "unclassified" }),
      reason: "unexpected-status",
      status: 409,
    },
  ])("does not replay unkeyed $reason", ({ body, status, reason }) =>
    Effect.gen(function* stopUnkeyedLettrUncertainty() {
      const fixture = yield* startEmailHttpFixture({ body, status });

      const outcome = yield* Effect.gen(function* submitUnkeyedLettrIntent() {
        return yield* (yield* Email).send(message);
      }).pipe(Effect.provide(fixtureLettrLayer(fixture, 3)), Effect.result);

      assert(Result.isFailure(outcome) && outcome.failure instanceof EmailDeliveryUnknown);
      assert.strictEqual(outcome.failure.reason, reason);
      assert.strictEqual(yield* Queue.size(fixture.received), 1);
    }),
  );

  it.live.each([
    { code: "invalid_domain", reason: "rejected", status: 400 },
    { code: "unconfigured_domain", reason: "rejected", status: 400 },
    { code: "insufficient_scope", reason: "rejected", status: 403 },
    { code: "template_not_found", reason: "rejected", status: 404 },
    { code: "validation_error", reason: "invalid-message", status: 422 },
    { code: "quota_exceeded", reason: "rejected", status: 429 },
    { code: "daily_quota_exceeded", reason: "rejected", status: 429 },
    { code: "unclassified", reason: "rejected", status: 429 },
    { code: "idempotency_key_conflict", reason: "idempotency-conflict", status: 409 },
  ])(
    "retains definite rejection $status/$code without private reasons or local repetition",
    ({ status, code, reason }) =>
      Effect.gen(function* classifyLettrSafeRejection() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify({
            error_code: code,
            errors: { to: ["private-recipient@example.test"] },
            message: "private-provider-reason",
          }),
          retryAfter: "1",
          status,
        });

        const outcome = yield* Effect.gen(function* submitRejectedLettrIntent() {
          return yield* (yield* Email).send(message, { idempotencyKey: "synthetic-key" });
        }).pipe(Effect.provide(fixtureLettrLayer(fixture, 3)), Effect.result);

        assert(Result.isFailure(outcome) && outcome.failure instanceof EmailRejected);
        assert.strictEqual(outcome.failure.reason, reason);
        assert.notInclude(JSON.stringify(outcome.failure), "private-");
        assert.strictEqual(yield* Queue.size(fixture.received), 1);
      }),
  );

  it.live(
    "stops actual fallback on native conflict and advances only a documented domain rejection",
    () =>
      Effect.gen(function* restrictLettrFallbackEvidence() {
        for (const status of [400, 409]) {
          const primary = yield* startEmailHttpFixture({
            body: JSON.stringify({
              error_code: status === 400 ? "unconfigured_domain" : "idempotency_key_conflict",
              message: "private-provider-reason",
            }),
            status,
          });

          const backup = yield* startEmailHttpFixture({
            body: JSON.stringify({ id: "backup-id" }),
            status: 200,
          });

          const outcome = yield* sendLettrRoute.pipe(
            Effect.provide(fixtureLettrRoute(primary, backup, 3)),
            Effect.result,
          );

          if (status === 400) {
            assert(
              Result.isSuccess(outcome) && EmailReceiptSchema.guards.Accepted(outcome.success),
            );
            assert.strictEqual(outcome.success.route, "backup");
            assert.strictEqual(yield* Queue.size(backup.received), 1);
          } else {
            assert(Result.isFailure(outcome) && outcome.failure instanceof EmailRejected);
            assert.strictEqual(outcome.failure.reason, "idempotency-conflict");
            assert.strictEqual(yield* Queue.size(backup.received), 0);
          }

          assert.strictEqual(yield* Queue.size(primary.received), 1);
        }
      }),
  );

  it.live.each([400, 403, 409, 422, 201, 202])(
    "does not turn unclassified/contradictory status %i into fallback or replay permission",
    (status) =>
      Effect.gen(function* stopUnprovenLettrStatus() {
        const primary = yield* startEmailHttpFixture({
          body: JSON.stringify({ ...acknowledgement, error_code: "private-unclassified" }),
          status,
        });

        const backup = yield* startEmailHttpFixture({
          body: JSON.stringify({ id: "backup-id" }),
          status: 200,
        });

        const outcome = yield* sendLettrRoute.pipe(
          Effect.provide(fixtureLettrRoute(primary, backup, 3)),
          Effect.result,
        );

        assert(Result.isFailure(outcome) && outcome.failure instanceof EmailDeliveryUnknown);
        assert.strictEqual(outcome.failure.reason, "unexpected-status");
        assert.strictEqual(yield* Queue.size(primary.received), 1);
        assert.strictEqual(yield* Queue.size(backup.received), 0);
      }),
  );

  it.live.each([
    "",
    "lttr_",
    "lttr_sandbox_private-key",
    "lttr_private key",
    "lttr_private\nkey",
    "api_private-key",
  ])("rejects malformed or recipient-rewriting credentials before HTTP (%j)", (apiKey) =>
    Effect.gen(function* rejectLettrCredential() {
      const fixture = yield* startEmailHttpFixture({
        body: JSON.stringify(acknowledgement),
        status: 200,
      });

      const outcome = yield* Effect.gen(function* submitInvalidLettrCredential() {
        return yield* (yield* Email).send(message);
      }).pipe(
        Effect.provide(
          lettrEmailLayer({ ...options, apiKey: Redacted.make(apiKey) }).pipe(
            Layer.provide(emailFixtureClientLayer(fixture.url, "https://app.lettr.com")),
          ),
        ),
        Effect.result,
      );

      assert(Result.isFailure(outcome) && outcome.failure instanceof EmailConfigurationError);
      assert.notInclude(JSON.stringify(outcome.failure), "private-");
      assert.strictEqual(yield* Queue.size(fixture.received), 0);
    }),
  );

  it.live("preserves the exact supported recipient, name, subject, tag and header boundaries", () =>
    Effect.gen(function* submitLettrSupportedBudgets() {
      const fixture = yield* startEmailHttpFixture({
        body: JSON.stringify({ data: { ...acknowledgement.data, accepted: 50 } }),
        status: 200,
      });

      const receipt = yield* Effect.gen(function* submitMaximumLettrIntent() {
        return yield* (yield* Email).send({
          ...message,
          from: { address: "sender@example.test", name: "n".repeat(255) },
          headers: [
            { name: "X-First", value: "h".repeat(998) },
            ...Array.from({ length: 9 }, (_, index) => ({
              name: `X-Header-${index}`,
              value: "synthetic",
            })),
          ],
          replyTo: { address: "reply@example.test", name: "r".repeat(255) },
          subject: "s".repeat(998),
          tags: [{ name: "p", value: "v".repeat(62) }],
          to: [
            "first@example.test",
            ...Array.from({ length: 49 }, (_, index) => `recipient-${index}@example.test`),
          ],
        });
      }).pipe(Effect.provide(fixtureLettrLayer(fixture)));

      assert(EmailReceiptSchema.guards.Accepted(receipt));
      const sent = yield* Queue.take(fixture.received);

      const wire = yield* Schema.decodeEffect(
        Schema.fromJsonString(
          Schema.Struct({
            from_name: Schema.String,
            headers: Schema.Record(Schema.String, Schema.String),
            reply_to_name: Schema.String,
            subject: Schema.String,
            tag: Schema.String,
            to: Schema.Array(Schema.String),
          }),
        ),
      )(sent.body);

      assert.strictEqual(wire.from_name, "n".repeat(255));
      assert.strictEqual(wire.reply_to_name, "r".repeat(255));
      assert.strictEqual(wire.subject, "s".repeat(998));
      assert.strictEqual(wire.tag, `p:${"v".repeat(62)}`);
      assert.strictEqual(wire.headers["X-First"], "h".repeat(998));
      assert.strictEqual(Object.keys(wire.headers).length, 10);
      assert.strictEqual(wire.to.length, 50);
      assert.strictEqual(wire.to[49], "recipient-48@example.test");
    }),
  );

  it.live.each([
    "private-malformed",
    JSON.stringify({ ...acknowledgement, error_code: "rate_limit_exceeded" }),
    JSON.stringify({ error_code: "quota_exceeded", status: "success" }),
  ])("never promotes malformed or contradictory rate evidence to non-acceptance (%j)", (body) =>
    Effect.gen(function* stopContradictoryLettrRateEvidence() {
      const primary = yield* startEmailHttpFixture({ body, status: 429 });

      const backup = yield* startEmailHttpFixture({
        body: JSON.stringify({ id: "backup-id" }),
        status: 200,
      });

      const outcome = yield* sendLettrRoute.pipe(
        Effect.provide(fixtureLettrRoute(primary, backup, 3)),
        Effect.result,
      );

      assert(Result.isFailure(outcome) && outcome.failure instanceof EmailDeliveryUnknown);
      assert.strictEqual(outcome.failure.reason, "invalid-response");
      assert.strictEqual(yield* Queue.size(primary.received), 1);
      assert.strictEqual(yield* Queue.size(backup.received), 0);
    }),
  );

  it.effect("keeps uncertain scheduling unkeyed and single-attempt despite a larger policy", () =>
    Effect.gen(function* stopUncertainLettrHold() {
      yield* TestClock.setTime(scheduledClockMillis);
      const fixture = yield* startEmailHttpFixture({ body: "private-server-error", status: 500 });

      const outcome = yield* Effect.gen(function* submitUncertainScheduledHold() {
        return yield* (yield* Email).send(scheduled);
      }).pipe(Effect.provide(fixtureLettrLayer(fixture, 3, "Scheduled")), Effect.result);

      assert(Result.isFailure(outcome) && outcome.failure instanceof EmailDeliveryUnknown);
      assert.strictEqual(outcome.failure.reason, "server-error");
      assert.strictEqual(yield* Queue.size(fixture.received), 1);
      assert.strictEqual((yield* Queue.take(fixture.received)).idempotencyKey, "");
    }),
  );

  it.live(
    "owns public HTTP authority including restricted keys and duration internals before direct submission",
    () =>
      Effect.gen(function* preserveLettrAuthoritySnapshot() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 200,
        });

        yield* Effect.gen(function* attemptAuthorityWidening() {
          const sender = yield* EmailSender;
          assert(EmailSenderIdempotencySchema.guards.Native(sender.idempotency));
          assert.strictEqual(Reflect.set(sender.idempotency, "keyFormat", "Opaque"), false);
          assert.strictEqual(Reflect.set(sender.idempotency, "maxKeyLength", 256), false);
          assert.strictEqual(
            Reflect.set(sender.idempotency.retention.value, "millis", 172_800_000),
            false,
          );
          assert.strictEqual(Duration.toMillis(sender.idempotency.retention), 86_400_000);
          const owned = yield* parseEmailMessage(message);
          const invalidKey = yield* Schema.decodeEffect(EmailIdempotencyKeySchema)("invalid/key");

          const rejected = yield* sender
            .submit({ idempotencyKey: invalidKey, message: owned })
            .pipe(Effect.result);

          assert(Result.isFailure(rejected) && rejected.failure instanceof EmailRejected);
          assert.strictEqual(rejected.failure.reason, "unsupported-idempotency");
          assert.strictEqual(yield* Queue.size(fixture.received), 0);
          const key = yield* Schema.decodeEffect(EmailIdempotencyKeySchema)("Valid.key_1-2");
          assert(
            EmailReceiptSchema.guards.Accepted(
              yield* sender.submit({ idempotencyKey: key, message: owned }),
            ),
          );
          assert.strictEqual((yield* Queue.take(fixture.received)).idempotencyKey, "Valid.key_1-2");
        }).pipe(
          Effect.provide(
            lettrSenderLayer(options).pipe(
              Layer.provide(emailFixtureClientLayer(fixture.url, "https://app.lettr.com")),
            ),
          ),
        );
      }),
  );

  it.live(
    "requires an explicit endpoint mode at acquisition and enforces 24-hour native policy authority",
    () =>
      Effect.gen(function* requireLettrModeAndRetention() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 200,
        });

        // @ts-expect-error -- Untyped callers cannot omit endpoint/replay authority.
        const missingMode = lettrEmailLayer({ apiKey: options.apiKey });

        const outcome = yield* Effect.gen(function* submitUnconfiguredLettrMode() {
          return yield* (yield* Email).send(message);
        }).pipe(
          Effect.provide(
            missingMode.pipe(
              Layer.provide(emailFixtureClientLayer(fixture.url, "https://app.lettr.com")),
            ),
          ),
          Effect.result,
        );

        assert(Result.isFailure(outcome) && outcome.failure instanceof EmailConfigurationError);

        const unsafe = yield* Effect.gen(function* submitOutsideLettrRetention() {
          return yield* (yield* Email).send(message);
        }).pipe(
          Effect.provide(
            lettrEmailLayer(options, {
              ...policy,
              deadline: Duration.hours(24),
              maxAttempts: 2,
            }).pipe(Layer.provide(emailFixtureClientLayer(fixture.url, "https://app.lettr.com"))),
          ),
          Effect.result,
        );

        assert(Result.isFailure(unsafe) && unsafe.failure instanceof EmailConfigurationError);
        yield* Effect.gen(function* inspectLettrOperationRetention() {
          const email = yield* Email;

          const invalid = yield* email
            .send(message, {
              idempotencyKey: "synthetic-key",
              policy: { ...policy, deadline: Duration.hours(24), maxAttempts: 2 },
            })
            .pipe(Effect.result);

          assert(Result.isFailure(invalid) && invalid.failure instanceof EmailInvalidOptions);
          assert.strictEqual(yield* Queue.size(fixture.received), 0);
          assert(
            EmailReceiptSchema.guards.Accepted(
              yield* email.send(message, {
                policy: { ...policy, deadline: Duration.hours(24), maxAttempts: 1 },
              }),
            ),
          );
        }).pipe(Effect.provide(fixtureLettrLayer(fixture)));
        assert.strictEqual(yield* Queue.size(fixture.received), 1);
      }),
  );
});
