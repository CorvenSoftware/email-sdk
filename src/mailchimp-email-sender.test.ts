import { assert, describe, it } from "@effect/vitest";
import {
  DateTime,
  Deferred,
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
import { HttpClient } from "effect/http";
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
  parseEmailMessage,
  emailRouterLayer,
} from "./index.js";
import { mailchimpEmailLayer, mailchimpSenderLayer } from "./mailchimp-email-sender.js";
import type { MailchimpTagStatisticsInput } from "./mailchimp-email-sender.js";
import { resendEmailLayer } from "./resend-email-sender.js";

const message = {
  body: { html: "<p>Synthetic café *|LITERAL|*</p>", text: "Synthetic café *|LITERAL|*" },
  from: { address: "sender@example.test", name: 'Fictional "Café"' },
  subject: "Synthetic Mailchimp notification",
  to: ["recipient@example.test"],
} as const;

const options = {
  apiKey: Redacted.make("fictional-mailchimp-key"),
  automaticFooter: "AccountDisabled",
  keyMode: "Live",
  messageRules: "AccountDisabled",
} as const;

const policy = {
  deadline: Duration.seconds(5),
  initialDelay: Duration.millis(100),
  maxAttempts: 3,
};

const acknowledgement = [
  { _id: "private-opaque-id", email: "recipient@example.test", status: "sent" },
];

const fixtureMailchimpLayer = (fixture: EmailHttpFixture) =>
  mailchimpEmailLayer(options, policy).pipe(
    Layer.provide(emailFixtureClientLayer(fixture.url, "https://mandrillapp.com")),
  );

const fixtureTaggedMailchimpLayer = (
  fixture: EmailHttpFixture,
  knownTags: MailchimpTagStatisticsInput["knownTags"],
) =>
  mailchimpEmailLayer(
    { ...options, tagStatistics: { authority: "AuthorizeKnownAccountTagStatistics", knownTags } },
    policy,
  ).pipe(Layer.provide(emailFixtureClientLayer(fixture.url, "https://mandrillapp.com")));

const fixtureMailchimpRoute = (
  primary: EmailHttpFixture,
  backup: EmailHttpFixture,
  tagStatistics?: MailchimpTagStatisticsInput,
) =>
  emailRouterLayer(
    [
      {
        layer:
          tagStatistics === undefined
            ? fixtureMailchimpLayer(primary)
            : fixtureTaggedMailchimpLayer(primary, tagStatistics.knownTags),
        name: "primary",
      },
      {
        layer: resendEmailLayer({ apiKey: Redacted.make("fictional-backup-key") }, policy).pipe(
          Layer.provide(emailFixtureClientLayer(backup.url, "https://api.resend.com")),
        ),
        name: "backup",
      },
    ],
    { fallbacks: ["backup"], primary: "primary" },
  );

const routedSend = Effect.gen(function* submitMailchimpRoute() {
  return yield* (yield* (yield* EmailRouter).select()).send(message);
});

const MailchimpWire = Schema.Struct({
  async: Schema.Boolean,
  key: Schema.String,
  message: Schema.Struct({
    attachments: Schema.Array(
      Schema.Struct({ content: Schema.String, name: Schema.String, type: Schema.String }),
    ),
    auto_html: Schema.Boolean,
    auto_text: Schema.Boolean,
    bcc_address: Schema.Null,
    from_email: Schema.String,
    from_name: Schema.String,
    google_analytics_domains: Schema.Array(Schema.String),
    headers: Schema.Record(Schema.String, Schema.String),
    html: Schema.String,
    images: Schema.Array(
      Schema.Struct({ content: Schema.String, name: Schema.String, type: Schema.String }),
    ),
    important: Schema.Boolean,
    inline_css: Schema.Boolean,
    merge: Schema.Boolean,
    metadata: Schema.Record(Schema.String, Schema.String),
    preserve_recipients: Schema.Boolean,
    subject: Schema.String,
    text: Schema.String,
    to: Schema.Array(
      Schema.Struct({
        email: Schema.String,
        name: Schema.optionalKey(Schema.String),
        type: Schema.String,
      }),
    ),
    track_clicks: Schema.Boolean,
    track_opens: Schema.Boolean,
    url_strip_qs: Schema.Boolean,
    view_content_link: Schema.Boolean,
  }),
});

const MailchimpTagsWire = Schema.Struct({
  message: Schema.Struct({
    merge: Schema.Boolean,
    tags: Schema.Array(Schema.String),
    track_clicks: Schema.Boolean,
    track_opens: Schema.Boolean,
  }),
});

const knownStatistics: MailchimpTagStatisticsInput = {
  authority: "AuthorizeKnownAccountTagStatistics",
  knownTags: [{ name: "workflow", value: "private:v1" }],
};

describe("Mailchimp Transactional actual submission protocol", () => {
  it.effect.prop(
    "preserves generated known account labels without dropping tag names or enabling tracking",
    {
      fragments: Schema.NonEmptyArray(Schema.Literals(["a", "é", "😀", ":", '"', "\\"])).check(
        Schema.isMaxLength(8),
      ),
    },
    ({ fragments }) =>
      Effect.gen(function* preserveKnownMailchimpTags() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 200,
        });

        const tag = { name: "private-statistic", value: fragments.join("") };
        const channel = { name: "channel", value: "fictional" };
        const trace = yield* startEmailTraceFixture();

        const receipt = yield* Effect.gen(function* submitKnownMailchimpTag() {
          const email = yield* Email;
          assert.strictEqual(email.capabilities.tags.maxCount, 2);
          yield* email.validate({ ...message, tags: [channel, tag] });
          assert.strictEqual(yield* Queue.size(fixture.received), 0);

          return yield* email.send({ ...message, tags: [channel, tag] });
        }).pipe(
          Effect.provide(fixtureTaggedMailchimpLayer(fixture, [tag, channel])),
          Effect.withTracer(trace.tracer),
        );

        assert(EmailReceiptSchema.guards.RecipientOutcomes(receipt));

        const wire = yield* Schema.decodeEffect(Schema.fromJsonString(MailchimpTagsWire))(
          (yield* Queue.take(fixture.received)).body,
        );

        assert.deepStrictEqual(wire.message.tags, [
          "channel:fictional",
          `private-statistic:${tag.value}`,
        ]);
        assert.isFalse(wire.message.merge);
        assert.isFalse(wire.message.track_clicks);
        assert.isFalse(wire.message.track_opens);
        assert.notInclude(yield* trace.diagnostics, "private-statistic");
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
    { arbitrary: { runs: 12 } },
  );

  it.effect(
    "retains exact fifty-byte UTF-8 labels and detaches the known-label profile at acquisition",
    () =>
      Effect.gen(function* ownMailchimpStatisticLabels() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 200,
        });

        const value = "é".repeat(24);
        const knownTags: [{ name: string; value: string }] = [{ name: "a", value }];
        yield* Effect.gen(function* inspectOwnedMailchimpLabels() {
          const email = yield* Email;
          knownTags[0].value = "private-mutated";
          assert(
            EmailReceiptSchema.guards.RecipientOutcomes(
              yield* email.send({ ...message, tags: [{ name: "a", value }] }),
            ),
          );
          const invalid = yield* email.send({ ...message, tags: knownTags }).pipe(Effect.result);
          assert(Result.isFailure(invalid));
          assert(invalid.failure instanceof EmailInvalidMessage);
          assert.notInclude(JSON.stringify(invalid), "private-mutated");
        }).pipe(Effect.provide(fixtureTaggedMailchimpLayer(fixture, knownTags)));

        const wire = yield* Schema.decodeEffect(Schema.fromJsonString(MailchimpTagsWire))(
          (yield* Queue.take(fixture.received)).body,
        );

        assert.deepStrictEqual(wire.message.tags, [`a:${value}`]);
        assert.strictEqual(Buffer.byteLength(wire.message.tags[0] ?? ""), 50);
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );

  it.effect.each([
    { name: "workflow", value: "private-unapproved" },
    { name: "Workflow", value: "private:v1" },
    { name: "workflow:private", value: "v1" },
    { name: "_reserved", value: "private" },
    { name: "workflow", value: "é".repeat(24) },
  ])(
    "refuses unapproved or lossy labels before transport at validation/send/direct boundaries (case %#)",
    (tag) =>
      Effect.gen(function* refuseUnknownMailchimpTag() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 200,
        });

        const layer = mailchimpSenderLayer({ ...options, tagStatistics: knownStatistics }).pipe(
          Layer.provide(emailFixtureClientLayer(fixture.url, "https://mandrillapp.com")),
        );

        yield* Effect.gen(function* inspectMailchimpTagRefusal() {
          const sender = yield* EmailSender;
          const input = { ...message, tags: [tag] as const };
          const parsed = yield* parseEmailMessage(input);
          const invalid = yield* sender.validate(parsed).pipe(Effect.result);
          assert(Result.isFailure(invalid));
          assert(invalid.failure instanceof EmailInvalidMessage);
          const direct = yield* sender.submit({ message: parsed }).pipe(Effect.result);
          assert(Result.isFailure(direct));
          assert(direct.failure instanceof EmailRejected);
          assert.strictEqual(direct.failure.reason, "invalid-message");
          assert.notInclude(JSON.stringify(direct.failure), "private");
        }).pipe(Effect.provide(layer));

        const invalid = yield* Email.pipe(
          Effect.flatMap((email) => email.send({ ...message, tags: [tag] })),
          Effect.provide(fixtureTaggedMailchimpLayer(fixture, knownStatistics.knownTags)),
          Effect.result,
        );

        assert(Result.isFailure(invalid));
        assert(invalid.failure instanceof EmailInvalidMessage);
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );

  it.effect.each([
    {},
    { authority: "NotAuthorized", knownTags: [{ name: "workflow", value: "private" }] },
    { authority: "AuthorizeKnownAccountTagStatistics", knownTags: [] },
    {
      authority: "AuthorizeKnownAccountTagStatistics",
      knownTags: [{ name: "workflow", value: "private\uD800" }],
    },
    {
      authority: "AuthorizeKnownAccountTagStatistics",
      knownTags: [{ name: "_private", value: "reserved" }],
    },
    {
      authority: "AuthorizeKnownAccountTagStatistics",
      knownTags: [{ name: "private:workflow", value: "v1" }],
    },
    {
      authority: "AuthorizeKnownAccountTagStatistics",
      knownTags: [{ name: "a", value: `${"é".repeat(24)}x` }],
    },
    {
      authority: "AuthorizeKnownAccountTagStatistics",
      knownTags: [
        { name: "workflow", value: "private" },
        { name: "Workflow", value: "PRIVATE" },
      ],
    },
    {
      authority: "AuthorizeKnownAccountTagStatistics",
      knownTags: Array.from({ length: 101 }, (_, index) => ({
        name: "workflow",
        value: String(index),
      })),
    },
  ])(
    "refuses malformed, ambiguous or over-budget untyped account profiles without transport (case %#)",
    (profile) =>
      Effect.gen(function* rejectMailchimpStatisticsProfile() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 200,
        });

        const mutable = { ...options };
        Reflect.set(mutable, "tagStatistics", profile);

        const invalid = yield* Email.pipe(
          Effect.provide(
            mailchimpEmailLayer(mutable).pipe(
              Layer.provide(emailFixtureClientLayer(fixture.url, "https://mandrillapp.com")),
            ),
          ),
          Effect.result,
        );

        assert(Result.isFailure(invalid));
        assert(invalid.failure instanceof EmailConfigurationError);
        assert.notInclude(JSON.stringify(invalid.failure), "private");
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );

  it.effect(
    "supports a bounded existing-label vocabulary without inferring account capacity or dropping pair identity",
    () =>
      Effect.gen(function* useKnownMailchimpVocabulary() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 200,
        });

        const knownTags: MailchimpTagStatisticsInput["knownTags"] = [
          { name: "workflow", value: "first" },
          ...Array.from({ length: 99 }, (_, index) => ({ name: "workflow", value: String(index) })),
        ];

        yield* Email.pipe(
          Effect.flatMap((email) => {
            assert.strictEqual(email.capabilities.tags.maxCount, 1);

            return email.send({ ...message, tags: [{ name: "workflow", value: "98" }] });
          }),
          Effect.provide(fixtureTaggedMailchimpLayer(fixture, knownTags)),
        );

        const wire = yield* Schema.decodeEffect(Schema.fromJsonString(MailchimpTagsWire))(
          (yield* Queue.take(fixture.received)).body,
        );

        assert.deepStrictEqual(wire.message.tags, ["workflow:98"]);
      }),
  );

  it.effect(
    "preflights tags against a default-disabled backup before touching an approved primary",
    () =>
      Effect.gen(function* preflightAllMailchimpLabelCandidates() {
        const primary = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 200,
        });

        const backup = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 200,
        });

        const route = emailRouterLayer(
          [
            {
              layer: fixtureTaggedMailchimpLayer(primary, knownStatistics.knownTags),
              name: "primary",
            },
            { layer: fixtureMailchimpLayer(backup), name: "backup" },
          ],
          { fallbacks: ["backup"], primary: "primary" },
        );

        const invalid = yield* Email.pipe(
          Effect.flatMap((email) => email.send({ ...message, tags: knownStatistics.knownTags })),
          Effect.provide(route),
          Effect.result,
        );

        assert(Result.isFailure(invalid));
        assert(invalid.failure instanceof EmailInvalidMessage);
        assert.strictEqual(yield* Queue.size(primary.received), 0);
        assert.strictEqual(yield* Queue.size(backup.received), 0);
      }),
  );

  it.effect.each([402, 503])(
    "keeps tag permission distinct from rejection-only fallback (%s)",
    (status) =>
      Effect.gen(function* preserveTaggedMailchimpFallback() {
        const primary = yield* startEmailHttpFixture({
          body: JSON.stringify({ code: 10, name: "PaymentRequired", status: "error" }),
          status,
        });

        const backup = yield* startEmailHttpFixture({
          body: JSON.stringify({ id: "backup-id" }),
          status: 200,
        });

        const statistics: MailchimpTagStatisticsInput = {
          authority: "AuthorizeKnownAccountTagStatistics",
          knownTags: [{ name: "workflow", value: "private-v1" }],
        };

        const result = yield* Effect.gen(function* submitTaggedMailchimpRoute() {
          return yield* (yield* (yield* EmailRouter).select()).send({
            ...message,
            tags: statistics.knownTags,
          });
        }).pipe(Effect.provide(fixtureMailchimpRoute(primary, backup, statistics)), Effect.result);

        assert.strictEqual(yield* Queue.size(primary.received), 1);

        if (status === 402) {
          assert(Result.isSuccess(result));
          assert.strictEqual(result.success.route, "backup");

          const wire = yield* Schema.decodeEffect(
            Schema.fromJsonString(
              Schema.Struct({
                tags: Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
              }),
            ),
          )((yield* Queue.take(backup.received)).body);

          assert.deepStrictEqual(wire.tags, statistics.knownTags);
        } else {
          assert(Result.isFailure(result));
          assert(result.failure instanceof EmailDeliveryUnknown);
          assert.strictEqual(yield* Queue.size(backup.received), 0);
        }
      }),
  );

  it.live(
    "preserves group visibility, literal content, named reply, native metadata and explicit image/attachment bytes",
    () =>
      Effect.gen(function* inspectMailchimpWire() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify([
            {
              _id: "hidden-id",
              email: "hidden@example.test",
              queued_reason: "attachments",
              status: "queued",
            },
            { _id: "first-id", email: "first@example.test", status: "sent" },
            { _id: "copy-id", email: "copy@example.test", status: "sent" },
            {
              _id: "second-id",
              email: "second@example.test",
              queued_reason: "multiple-recipients",
              status: "queued",
            },
          ]),
          status: 200,
        });

        const receipt = yield* Effect.gen(function* submitRichMailchimpIntent() {
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
                contentId: "sample.png",
                contentType: "image/png",
                filename: "sample.png",
              },
            ],
            bcc: { address: "hidden@example.test", name: "Fictional Hidden" },
            cc: { address: "copy@example.test", name: "Fictional Copy" },
            headers: [{ name: "X-Workflow", value: "synthetic" }],
            metadata: { workflow: "synthetic café" },
            replyTo: { address: "reply@example.test", name: "Fictional Reply" },
            to: [{ address: "first@example.test", name: "First Fictional" }, "second@example.test"],
          });
        }).pipe(Effect.provide(fixtureMailchimpLayer(fixture)));

        assert(EmailReceiptSchema.guards.RecipientOutcomes(receipt));
        assert.deepStrictEqual(
          receipt.outcomes.map(({ recipient, messageId }) => [String(recipient), messageId]),
          [
            ["first@example.test", "first-id"],
            ["second@example.test", "second-id"],
            ["copy@example.test", "copy-id"],
            ["hidden@example.test", "hidden-id"],
          ],
        );
        assert.isTrue(receipt.outcomes.every(({ _tag }) => _tag === "Accepted"));
        assert.isTrue(Object.isFrozen(receipt));
        assert.isTrue(Object.isFrozen(receipt.outcomes));
        assert.isTrue(receipt.outcomes.every(Object.isFrozen));
        assert.isFalse("messageId" in receipt);
        const sent = yield* Queue.take(fixture.received);
        assert.strictEqual(sent.method, "POST");
        assert.strictEqual(sent.path, "/api/1.4/messages/send");
        assert.strictEqual(sent.authorization, "");
        assert.strictEqual(sent.idempotencyKey, "");
        const wire = yield* Schema.decodeEffect(Schema.fromJsonString(MailchimpWire))(sent.body);
        assert.strictEqual(wire.key, "fictional-mailchimp-key");
        assert.isFalse(wire.async);
        const payload = wire.message;
        assert.strictEqual(payload.from_email, message.from.address);
        assert.strictEqual(payload.from_name, message.from.name);
        assert.deepStrictEqual(payload.to, [
          { email: "first@example.test", name: "First Fictional", type: "to" },
          { email: "second@example.test", type: "to" },
          { email: "copy@example.test", name: "Fictional Copy", type: "cc" },
          { email: "hidden@example.test", name: "Fictional Hidden", type: "bcc" },
        ]);
        assert.strictEqual(payload.subject, message.subject);
        assert.strictEqual(payload.text, message.body.text);
        assert.strictEqual(payload.html, message.body.html);
        assert.strictEqual(payload.headers["Reply-To"], '"Fictional Reply" <reply@example.test>');
        assert.strictEqual(payload.headers["X-Workflow"], "synthetic");
        assert.strictEqual(payload.metadata.workflow, "synthetic café");
        const [attachment] = payload.attachments;
        const [image] = payload.images;
        assert.isDefined(attachment);
        assert.isDefined(image);
        assert.deepStrictEqual([...Buffer.from(attachment.content, "base64")], [0, 255, 128, 10]);
        assert.strictEqual(attachment.name, "sample.dat");
        assert.strictEqual(attachment.type, "application/octet-stream");
        assert.deepStrictEqual([...Buffer.from(image.content, "base64")], [1]);
        assert.strictEqual(image.name, "sample.png");
        assert.strictEqual(image.type, "image/png");

        for (const enabled of [
          payload.auto_html,
          payload.auto_text,
          payload.inline_css,
          payload.merge,
          payload.track_clicks,
          payload.track_opens,
          payload.url_strip_qs,
          payload.view_content_link,
          payload.important,
        ]) {
          assert.isFalse(enabled);
        }

        assert.isTrue(payload.preserve_recipients);
        assert.isNull(payload.bcc_address);
        assert.deepStrictEqual(payload.google_analytics_domains, []);
        assert.notInclude(sent.body, '"global_merge_vars"');
        assert.notInclude(sent.body, '"send_at"');
      }),
  );

  it.effect.each([
    { accepted: 0, total: 2 },
    { accepted: 1, total: 2 },
    { accepted: 2, total: 2 },
    { accepted: 0, total: 50 },
    { accepted: 25, total: 50 },
    { accepted: 50, total: 50 },
  ])(
    "retains $accepted/$total accepted recipient outcomes with original order and no fallback or trace disclosure",
    ({ accepted, total }) =>
      Effect.gen(function* preserveMailchimpOutcomes() {
        const members = [
          "First@example.test",
          ...Array.from({ length: total - 1 }, (_, index) => `member-${index}@example.test`),
        ];

        const primary = yield* startEmailHttpFixture({
          body: JSON.stringify(
            members
              .map((email, index) =>
                index < accepted
                  ? {
                      _id: `private-id-${index}`,
                      email: email.toUpperCase(),
                      queued_reason: "hourly-quota-exhausted",
                      status: "queued",
                    }
                  : {
                      _id: null,
                      email: email.toLowerCase(),
                      reject_reason: "unsub",
                      status: "rejected",
                    },
              )
              .toReversed(),
          ),
          status: 200,
        });

        const backup = yield* startEmailHttpFixture({
          body: JSON.stringify({ id: "backup-id" }),
          status: 200,
        });

        const trace = yield* startEmailTraceFixture();

        const receipt = yield* Effect.gen(function* submitMailchimpAudience() {
          return yield* (yield* (yield* EmailRouter).select()).send({
            ...message,
            to: ["First@example.test", ...members.slice(1)],
          });
        }).pipe(
          Effect.provide(fixtureMailchimpRoute(primary, backup)),
          Effect.provideService(Tracer.Tracer, trace.tracer),
        );

        assert(EmailReceiptSchema.guards.RecipientOutcomes(receipt));
        assert.strictEqual(receipt.route, "primary");
        assert.deepStrictEqual(
          receipt.outcomes.map(({ recipient }) => String(recipient)),
          members,
        );
        assert.strictEqual(
          receipt.outcomes.filter(({ _tag }) => _tag === "Accepted").length,
          accepted,
        );
        assert.isTrue(Object.isFrozen(receipt.outcomes));
        assert.isTrue(receipt.outcomes.every(Object.isFrozen));

        for (const [index, outcome] of receipt.outcomes.entries()) {
          if (index < accepted) {
            assert.strictEqual(outcome._tag, "Accepted");
            assert.strictEqual(outcome.messageId, `private-id-${index}`);
          } else {
            assert.strictEqual(outcome._tag, "Rejected");
            assert.isFalse("messageId" in outcome);
          }
        }

        assert.strictEqual(yield* Queue.size(primary.received), 1);
        assert.strictEqual(yield* Queue.size(backup.received), 0);
        const diagnostics = yield* trace.diagnostics;
        assert.include(diagnostics, "Mailchimp.submit");
        assert.notInclude(diagnostics, "private-");
        assert.notInclude(diagnostics, "example.test");
        assert.notInclude(diagnostics, "unsub");
        assert.notInclude(diagnostics, "café");
      }),
  );

  it.live.each([
    "attachments",
    "multiple-recipients",
    "free-trial-sends-exhausted",
    "hourly-quota-exhausted",
    "monthly-limit-reached",
    "sending-paused",
    "sending-suspended",
    "account-suspended",
    "sending-backlogged",
  ])("treats provider queue reason %s as submission, never retry or delivery", (queued_reason) =>
    Effect.gen(function* acknowledgeMailchimpQueue() {
      const primary = yield* startEmailHttpFixture({
        body: JSON.stringify([{ ...acknowledgement[0], queued_reason, status: "queued" }]),
        status: 200,
      });

      const backup = yield* startEmailHttpFixture({
        body: JSON.stringify({ id: "backup-id" }),
        status: 200,
      });

      const receipt = yield* routedSend.pipe(
        Effect.provide(fixtureMailchimpRoute(primary, backup)),
      );

      assert(EmailReceiptSchema.guards.RecipientOutcomes(receipt));
      assert.strictEqual(receipt.outcomes[0]._tag, "Accepted");
      assert.strictEqual(yield* Queue.size(primary.received), 1);
      assert.strictEqual(yield* Queue.size(backup.received), 0);
      assert.notInclude(JSON.stringify(receipt), queued_reason);
    }),
  );

  it.live.each([
    [],
    {},
    [{ ...acknowledgement[0], email: "foreign@example.test" }],
    [acknowledgement[0], acknowledgement[0]],
    [{ ...acknowledgement[0], _id: null }],
    [{ ...acknowledgement[0], _id: "invalid id" }],
    [{ ...acknowledgement[0], status: "scheduled" }],
    [{ ...acknowledgement[0], reject_reason: "unsub" }],
    [{ ...acknowledgement[0], queued_reason: "attachments" }],
    [{ ...acknowledgement[0], queued_reason: "private-unknown-reason", status: "queued" }],
    [{ ...acknowledgement[0], queued_reason: "attachments", status: "rejected" }],
    [{ ...acknowledgement[0], reject_reason: "private-unknown-reason", status: "rejected" }],
  ])(
    "keeps missing, foreign, contradictory and unrecognized recipient evidence unknown (%j)",
    (body) =>
      Effect.gen(function* rejectMailchimpEvidence() {
        const primary = yield* startEmailHttpFixture({ body: JSON.stringify(body), status: 200 });

        const backup = yield* startEmailHttpFixture({
          body: JSON.stringify({ id: "backup-id" }),
          status: 200,
        });

        const outcome = yield* routedSend.pipe(
          Effect.provide(fixtureMailchimpRoute(primary, backup)),
          Effect.result,
        );

        assert(Result.isFailure(outcome));
        assert(outcome.failure instanceof EmailDeliveryUnknown);
        assert.strictEqual(outcome.failure.reason, "invalid-response");
        assert.notInclude(JSON.stringify(outcome.failure), "private-");
        assert.notInclude(JSON.stringify(outcome.failure), "example.test");
        assert.strictEqual(yield* Queue.size(primary.received), 1);
        assert.strictEqual(yield* Queue.size(backup.received), 0);
      }),
  );

  it.live("rejects duplicated native IDs even when the complete address partition is valid", () =>
    Effect.gen(function* rejectMailchimpDuplicateHandles() {
      const fixture = yield* startEmailHttpFixture({
        body: JSON.stringify([
          acknowledgement[0],
          {
            _id: "private-opaque-id",
            email: "copy@example.test",
            reject_reason: "unsigned",
            status: "rejected",
          },
        ]),
        status: 200,
      });

      const outcome = yield* Effect.gen(function* submitDuplicateMailchimpIds() {
        return yield* (yield* Email).send({ ...message, cc: "copy@example.test" });
      }).pipe(Effect.provide(fixtureMailchimpLayer(fixture)), Effect.result);

      assert(Result.isFailure(outcome));
      assert(outcome.failure instanceof EmailDeliveryUnknown);
      assert.strictEqual(yield* Queue.size(fixture.received), 1);
    }),
  );

  it.live.each([
    { code: 401, name: "Invalid_Key", status: 401 },
    { code: 10, name: "PaymentRequired", status: 402 },
  ])("advances only after exact current-version whole-request refusal %j", (proof) =>
    Effect.gen(function* fallbackMailchimpRefusal() {
      const primary = yield* startEmailHttpFixture({
        body: JSON.stringify({
          code: proof.code,
          message: "private-reason",
          name: proof.name,
          status: "error",
        }),
        status: proof.status,
      });

      const backup = yield* startEmailHttpFixture({
        body: JSON.stringify({ id: "backup-id" }),
        status: 200,
      });

      const receipt = yield* routedSend.pipe(
        Effect.provide(fixtureMailchimpRoute(primary, backup)),
      );

      assert(EmailReceiptSchema.guards.Accepted(receipt));
      assert.strictEqual(receipt.route, "backup");
      assert.strictEqual(yield* Queue.size(primary.received), 1);
      assert.strictEqual(yield* Queue.size(backup.received), 1);
    }),
  );

  it.live.each([400, 404, 409, 429, 500, 503, 504])(
    "does not borrow generic or legacy send replay from HTTP %s",
    (status) =>
      Effect.gen(function* preserveMailchimpUncertainty() {
        const primary = yield* startEmailHttpFixture({
          body: JSON.stringify({
            code: -1,
            message: "private-reason",
            name: "Invalid_Key",
            status: "error",
          }),
          retryAfter: "0",
          status,
        });

        const backup = yield* startEmailHttpFixture({
          body: JSON.stringify({ id: "backup-id" }),
          status: 200,
        });

        const outcome = yield* routedSend.pipe(
          Effect.provide(fixtureMailchimpRoute(primary, backup)),
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

  it.live.each([
    {},
    { code: -1, name: "Invalid_Key", status: "error" },
    { code: 401, name: "Unknown", status: "error" },
    { code: 401, name: "Invalid_Key", status: "sent" },
    { _id: "private-id", code: 401, name: "Invalid_Key", status: "error" },
  ])("refuses incomplete or contradictory authentication proof (%j)", (body) =>
    Effect.gen(function* rejectMailchimpFailureProof() {
      const primary = yield* startEmailHttpFixture({ body: JSON.stringify(body), status: 401 });

      const backup = yield* startEmailHttpFixture({
        body: JSON.stringify({ id: "backup-id" }),
        status: 200,
      });

      const outcome = yield* routedSend.pipe(
        Effect.provide(fixtureMailchimpRoute(primary, backup)),
        Effect.result,
      );

      assert(Result.isFailure(outcome));
      assert(outcome.failure instanceof EmailDeliveryUnknown);
      assert.strictEqual(yield* Queue.size(primary.received), 1);
      assert.strictEqual(yield* Queue.size(backup.received), 0);
    }),
  );

  it.live.each([
    { ...message, sendAt: "1970-01-01T00:00:00Z" },
    { ...message, tags: [{ name: "workflow", value: "synthetic" }] },
    { ...message, replyTo: ["reply@example.test", "other@example.test"] },
    { ...message, cc: "RECIPIENT@example.test" },
    { ...message, headers: [{ name: "X-MC-Track", value: "opens,clicks" }] },
    { ...message, headers: [{ name: "X-Mandrill-SendAt", value: "private-value" }] },
    { ...message, body: { html: '<a href="*|UNSUB:https://example.test|*">stop</a>' } },
    { ...message, metadata: { _reserved: "private-value" } },
    { ...message, metadata: { workflow: "界".repeat(79) } },
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
          contentId: "inline",
          contentType: "image/png",
          filename: "sample.png",
        },
      ],
    },
    {
      ...message,
      attachments: [
        {
          contentBase64: "AQ==",
          contentId: "sample.dat",
          contentType: "application/octet-stream",
          filename: "sample.dat",
        },
      ],
    },
    { ...message, body: { html: "\u0000".repeat(900_000), text: "\u0000".repeat(900_000) } },
  ] as const)("preflights unsupported or lossy intent before every candidate (case %#)", (input) =>
    Effect.gen(function* preflightMailchimpIntent() {
      const primary = yield* startEmailHttpFixture({
        body: JSON.stringify(acknowledgement),
        status: 200,
      });

      const backup = yield* startEmailHttpFixture({
        body: JSON.stringify({ id: "backup-id" }),
        status: 200,
      });

      const outcome = yield* Effect.gen(function* submitInvalidMailchimpIntent() {
        return yield* (yield* (yield* EmailRouter).select()).send(input);
      }).pipe(Effect.provide(fixtureMailchimpRoute(primary, backup)), Effect.result);

      assert(Result.isFailure(outcome));
      assert(outcome.failure instanceof EmailInvalidMessage);
      assert.notInclude(JSON.stringify(outcome.failure), "private-");
      assert.strictEqual(yield* Queue.size(primary.received), 0);
      assert.strictEqual(yield* Queue.size(backup.received), 0);
    }),
  );

  it.effect.prop(
    "preserves generated future UTC seconds on the wire with terminal correlated scheduling evidence",
    { seconds: Schema.Int.check(Schema.isBetween({ maximum: 31_536_000, minimum: 1 })) },
    ({ seconds }) =>
      Effect.gen(function* submitMailchimpSchedule() {
        yield* TestClock.setTime(
          DateTime.toEpochMillis(DateTime.makeUnsafe("2028-02-28T23:59:59Z")),
        );
        const sendAt = DateTime.add(yield* DateTime.now, { seconds });

        const primary = yield* startEmailHttpFixture({
          body: JSON.stringify([
            {
              _id: "private-copy",
              email: "copy@example.test",
              reject_reason: "unsub",
              status: "rejected",
            },
            { _id: "private-scheduled", email: "RECIPIENT@example.test", status: "scheduled" },
          ]),
          status: 200,
        });

        const backup = yield* startEmailHttpFixture({
          body: JSON.stringify({ id: "backup-id" }),
          status: 200,
        });

        const trace = yield* startEmailTraceFixture();

        const receipt = yield* Effect.gen(function* submitCorrelatedMailchimpSchedule() {
          return yield* (yield* (yield* EmailRouter).select()).send({
            ...message,
            cc: "copy@example.test",
            sendAt,
          });
        }).pipe(
          Effect.provide(
            emailRouterLayer(
              [
                { layer: fixtureMailchimpLayer(primary), name: "primary" },
                { layer: fixtureMailchimpLayer(backup), name: "backup" },
              ],
              { fallbacks: ["backup"], primary: "primary" },
            ),
          ),
          Effect.provideService(Tracer.Tracer, trace.tracer),
        );

        assert(EmailReceiptSchema.guards.RecipientOutcomes(receipt));
        assert.strictEqual(receipt.route, "primary");
        assert.deepStrictEqual(
          receipt.outcomes.map(({ _tag, recipient, messageId }) => [
            _tag,
            String(recipient),
            String(messageId),
          ]),
          [
            ["Accepted", "recipient@example.test", "private-scheduled"],
            ["Rejected", "copy@example.test", "private-copy"],
          ],
        );
        assert.isTrue(Object.isFrozen(receipt.outcomes));
        assert.isTrue(receipt.outcomes.every(Object.isFrozen));
        const sent = yield* Queue.take(primary.received);

        const wire = yield* Schema.decodeEffect(
          Schema.fromJsonString(
            Schema.Struct({
              async: Schema.Boolean,
              message: Schema.Struct({
                merge: Schema.Boolean,
                text: Schema.String,
                track_opens: Schema.Boolean,
              }),
              send_at: Schema.String,
            }),
          ),
        )(sent.body);

        const nativeInstant = DateTime.makeUnsafe(`${wire.send_at.replace(" ", "T")}Z`);
        assert.strictEqual(
          DateTime.toEpochMillis(nativeInstant) - DateTime.toEpochMillis(yield* DateTime.now),
          seconds * 1000,
        );
        assert.isFalse(wire.async);
        assert.isFalse(wire.message.track_opens);
        assert.isFalse(wire.message.merge);
        assert.strictEqual(wire.message.text, message.body.text);
        assert.strictEqual(yield* Queue.size(primary.received), 0);
        assert.strictEqual(yield* Queue.size(backup.received), 0);
        const diagnostics = yield* trace.diagnostics;
        assert.include(diagnostics, "Mailchimp.submit");

        for (const privateValue of ["private-", "example.test", "café", wire.send_at]) {
          assert.notInclude(diagnostics, privateValue);
        }
      }),
    { arbitrary: { runs: 12 } },
  );

  it.effect.each([
    "2030-01-01T00:00:00Z",
    "2029-12-31T23:59:59Z",
    "2030-01-01T00:00:00.001Z",
    "2031-01-01T00:00:01Z",
  ])("refuses expired, fractional or over-window scheduling before any route (%s)", (sendAt) =>
    Effect.gen(function* rejectMailchimpSchedule() {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2030-01-01T00:00:00Z")));

      const primary = yield* startEmailHttpFixture({
        body: JSON.stringify(acknowledgement),
        status: 200,
      });

      const backup = yield* startEmailHttpFixture({
        body: JSON.stringify({ id: "backup-id" }),
        status: 200,
      });

      yield* Effect.gen(function* validateMailchimpScheduleBoundaries() {
        const email = yield* Email;

        for (const operation of [
          email.validate({ ...message, sendAt }).pipe(Effect.asVoid),
          email.send({ ...message, sendAt }).pipe(Effect.asVoid),
        ]) {
          const result = yield* Effect.result(operation);
          assert(Result.isFailure(result));
          assert(result.failure instanceof EmailInvalidMessage);
          assert.deepStrictEqual(
            result.failure.issues.map(({ path }) => path),
            ["sendAt"],
          );
          assert.notInclude(JSON.stringify(result.failure), sendAt);
        }
      }).pipe(Effect.provide(fixtureMailchimpRoute(primary, backup)));
      assert.strictEqual(yield* Queue.size(primary.received), 0);
      assert.strictEqual(yield* Queue.size(backup.received), 0);
    }),
  );

  it.effect.each([
    [{ ...acknowledgement[0], status: "sent" }],
    [{ ...acknowledgement[0], queued_reason: "attachments", status: "queued" }],
    [{ ...acknowledgement[0], reject_reason: "unsub", status: "scheduled" }],
    [{ ...acknowledgement[0], queued_reason: "attachments", status: "scheduled" }],
    [{ ...acknowledgement[0], email: "foreign@example.test", status: "scheduled" }],
  ])("never replays or falls back from unproven scheduled acknowledgement (case %#)", (body) =>
    Effect.gen(function* refuseAmbiguousMailchimpSchedule() {
      const primary = yield* startEmailHttpFixture({ body: JSON.stringify(body), status: 200 });

      const backup = yield* startEmailHttpFixture({
        body: JSON.stringify({ id: "backup-id" }),
        status: 200,
      });

      const outcome = yield* Effect.gen(function* submitUnprovenMailchimpSchedule() {
        return yield* (yield* Email).send({ ...message, sendAt: "1970-01-02T00:00:00Z" });
      }).pipe(Effect.provide(fixtureMailchimpRoute(primary, backup)), Effect.result);

      assert(Result.isFailure(outcome));
      assert(outcome.failure instanceof EmailDeliveryUnknown);
      assert.strictEqual(outcome.failure.reason, "invalid-response");
      assert.strictEqual(yield* Queue.size(primary.received), 1);
      assert.strictEqual(yield* Queue.size(backup.received), 0);
    }),
  );

  it.effect("checks exact scheduling edges and direct submission again at execution", () =>
    Effect.gen(function* defendDirectMailchimpSchedule() {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2030-01-01T00:00:00Z")));

      const fixture = yield* startEmailHttpFixture({
        body: JSON.stringify([{ ...acknowledgement[0], status: "scheduled" }]),
        status: 200,
      });

      yield* Effect.gen(function* executeScheduledMailchimpSender() {
        const sender = yield* EmailSender;

        for (const seconds of [1, 31_536_000]) {
          const parsed = yield* parseEmailMessage({
            ...message,
            sendAt: DateTime.add(yield* DateTime.now, { seconds }),
          });

          const receipt = yield* sender.submit({ message: parsed });
          assert(EmailReceiptSchema.guards.RecipientOutcomes(receipt));
          assert.strictEqual(receipt.outcomes[0]._tag, "Accepted");
          yield* Queue.take(fixture.received);
        }

        const parsed = yield* parseEmailMessage({ ...message, sendAt: "2030-01-01T00:00:01Z" });
        yield* sender.validate(parsed);
        yield* TestClock.adjust("1 second");
        const result = yield* sender.submit({ message: parsed }).pipe(Effect.result);
        assert(Result.isFailure(result));
        assert(result.failure instanceof EmailRejected);
        assert.strictEqual(result.failure.reason, "invalid-message");
      }).pipe(
        Effect.provide(
          mailchimpSenderLayer(options).pipe(
            Layer.provide(emailFixtureClientLayer(fixture.url, "https://mandrillapp.com")),
          ),
        ),
      );
      assert.strictEqual(yield* Queue.size(fixture.received), 0);
    }),
  );

  it.effect(
    "owns queued schedules and refuses expiry without sending a stale instant immediately",
    () =>
      Effect.gen(function* expireQueuedMailchimpSchedule() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 200,
        });

        const entered = yield* Deferred.make<boolean>();
        const release = yield* Deferred.make<boolean>();

        const nativeClient = yield* Effect.service(HttpClient.HttpClient).pipe(
          Effect.provide(emailFixtureClientLayer(fixture.url, "https://mandrillapp.com")),
        );

        const client = HttpClient.make((request) =>
          Deferred.succeed(entered, true).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(nativeClient.execute(request)),
          ),
        );

        const queued = {
          ...message,
          sendAt: "1970-01-01T00:00:01Z",
          subject: "Owned queued schedule",
        };

        const outcomes = yield* Effect.gen(function* queueOwnedMailchimpSchedule() {
          const email = yield* Email;

          const batch = yield* email
            .sendAll([{ message }, { message: queued }], { concurrency: 1 })
            .pipe(Effect.forkChild);

          yield* Deferred.await(entered);
          queued.sendAt = "1970-01-02T00:00:00Z";
          yield* TestClock.adjust("1 second");
          yield* Deferred.succeed(release, true);

          return yield* Fiber.join(batch);
        }).pipe(
          Effect.provide(
            mailchimpEmailLayer(options, policy).pipe(
              Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
            ),
          ),
        );

        const [first, second] = outcomes;
        assert(first !== undefined && Result.isSuccess(first));
        assert(second !== undefined && Result.isFailure(second));
        assert(second.failure instanceof EmailRejected);
        assert.strictEqual(second.failure.reason, "invalid-message");
        assert.strictEqual(yield* Queue.size(fixture.received), 1);
      }),
  );

  it.effect("refuses extended years without truncation or remote submission", () =>
    Effect.gen(function* rejectExtendedMailchimpSchedule() {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("9999-12-31T00:00:00Z")));

      const fixture = yield* startEmailHttpFixture({
        body: JSON.stringify(acknowledgement),
        status: 200,
      });

      const outcome = yield* Effect.gen(function* submitExtendedMailchimpSchedule() {
        return yield* (yield* Email).send({
          ...message,
          sendAt: DateTime.makeUnsafe("+010000-01-01T00:00:00Z"),
        });
      }).pipe(Effect.provide(fixtureMailchimpLayer(fixture)), Effect.result);

      assert(Result.isFailure(outcome));
      assert(outcome.failure instanceof EmailInvalidMessage);
      assert.strictEqual(yield* Queue.size(fixture.received), 0);
    }),
  );

  it.effect("retains terminal scheduled audience rejection instead of bypassing suppression", () =>
    Effect.gen(function* retainRejectedMailchimpSchedule() {
      const primary = yield* startEmailHttpFixture({
        body: JSON.stringify([
          {
            _id: null,
            email: "recipient@example.test",
            reject_reason: "unsub",
            status: "rejected",
          },
        ]),
        status: 200,
      });

      const backup = yield* startEmailHttpFixture({
        body: JSON.stringify({ id: "backup-id" }),
        status: 200,
      });

      const receipt = yield* Effect.gen(function* submitRejectedMailchimpSchedule() {
        return yield* (yield* Email).send({ ...message, sendAt: "1970-01-02T00:00:00Z" });
      }).pipe(Effect.provide(fixtureMailchimpRoute(primary, backup)));

      assert(EmailReceiptSchema.guards.RecipientOutcomes(receipt));
      assert.strictEqual(receipt.outcomes[0]._tag, "Rejected");
      assert.isFalse("messageId" in receipt.outcomes[0]);
      assert.strictEqual(yield* Queue.size(primary.received), 1);
      assert.strictEqual(yield* Queue.size(backup.received), 0);
    }),
  );

  it.effect(
    "falls back only after a definite whole-request refusal with the original scheduled instant",
    () =>
      Effect.gen(function* fallbackRejectedMailchimpSchedule() {
        const primary = yield* startEmailHttpFixture({
          body: JSON.stringify({ code: 10, name: "PaymentRequired", status: "error" }),
          status: 402,
        });

        const backup = yield* startEmailHttpFixture({
          body: JSON.stringify({ id: "backup-id" }),
          status: 200,
        });

        const sendAt = "1970-01-02T00:00:00Z";

        const receipt = yield* Effect.gen(function* submitFallbackMailchimpSchedule() {
          return yield* (yield* (yield* EmailRouter).select()).send({ ...message, sendAt });
        }).pipe(Effect.provide(fixtureMailchimpRoute(primary, backup)));

        assert.strictEqual(receipt.route, "backup");
        assert.strictEqual(yield* Queue.size(primary.received), 1);

        const wire = yield* Schema.decodeEffect(
          Schema.fromJsonString(Schema.Struct({ scheduled_at: Schema.String })),
        )((yield* Queue.take(backup.received)).body);

        assert.strictEqual(
          DateTime.toEpochMillis(DateTime.makeUnsafe(wire.scheduled_at)),
          DateTime.toEpochMillis(DateTime.makeUnsafe(sendAt)),
        );
        assert.strictEqual(yield* Queue.size(backup.received), 0);
      }),
  );

  it.live("retains the exact conservative UTF-8 metadata boundary", () =>
    Effect.gen(function* inspectMailchimpMetadataBudget() {
      const fixture = yield* startEmailHttpFixture({
        body: JSON.stringify(acknowledgement),
        status: 200,
      });

      const receipt = yield* Effect.gen(function* submitBoundedMailchimpMetadata() {
        return yield* (yield* Email).send({ ...message, metadata: { workflow: "界".repeat(78) } });
      }).pipe(Effect.provide(fixtureMailchimpLayer(fixture)));

      assert(EmailReceiptSchema.guards.RecipientOutcomes(receipt));
      const sent = yield* Queue.take(fixture.received);

      const wire = yield* Schema.decodeEffect(
        Schema.fromJsonString(
          Schema.Struct({
            message: Schema.Struct({ metadata: Schema.Record(Schema.String, Schema.String) }),
          }),
        ),
      )(sent.body);

      assert.strictEqual(Buffer.byteLength(JSON.stringify(wire.message.metadata)), 249);
      assert.strictEqual(wire.message.metadata.workflow, "界".repeat(78));
    }),
  );

  it.live(
    "owns JSON-body credentials and rejects ignored keys at ordinary, direct and backup boundaries",
    () =>
      Effect.gen(function* defendMailchimpAuthority() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 200,
        });

        const mutable = { ...options, apiKey: Redacted.make("fictional-initial-key") };

        const senderLayer = mailchimpSenderLayer(mutable).pipe(
          Layer.provide(emailFixtureClientLayer(fixture.url, "https://mandrillapp.com")),
        );

        const direct = yield* Effect.gen(function* submitDirectMailchimpKey() {
          const sender = yield* EmailSender;
          assert.isTrue(Object.isFrozen(sender.idempotency));
          mutable.apiKey = Redacted.make("private-mutated-key");
          const parsed = yield* parseEmailMessage(message);

          const keyed = yield* sender
            .submit({
              idempotencyKey: EmailIdempotencyKeySchema.make("private-key"),
              message: parsed,
            })
            .pipe(Effect.result);

          assert(Result.isFailure(keyed));
          assert(keyed.failure instanceof EmailRejected);
          assert.strictEqual(keyed.failure.reason, "unsupported-idempotency");

          return yield* sender.submit({ message: parsed });
        }).pipe(Effect.provide(senderLayer));

        assert(EmailReceiptSchema.guards.RecipientOutcomes(direct));

        const wire = yield* Schema.decodeEffect(
          Schema.fromJsonString(Schema.Struct({ key: Schema.String })),
        )((yield* Queue.take(fixture.received)).body);

        assert.strictEqual(wire.key, "fictional-initial-key");

        const backup = yield* startEmailHttpFixture({
          body: JSON.stringify({ id: "backup-id" }),
          status: 200,
        });

        const routes = [
          fixtureMailchimpLayer(fixture),
          emailRouterLayer(
            [
              {
                layer: resendEmailLayer({ apiKey: Redacted.make("fictional-key") }, policy).pipe(
                  Layer.provide(emailFixtureClientLayer(backup.url, "https://api.resend.com")),
                ),
                name: "primary",
              },
              { layer: fixtureMailchimpLayer(fixture), name: "backup" },
            ],
            { fallbacks: ["backup"], primary: "primary" },
          ),
        ];

        for (const layer of routes) {
          const outcome = yield* Effect.gen(function* submitUnsupportedMailchimpKey() {
            return yield* (yield* Email).send(message, { idempotencyKey: "private-key" });
          }).pipe(Effect.provide(layer), Effect.result);

          assert(Result.isFailure(outcome));
          assert(outcome.failure instanceof EmailRejected);
          assert.strictEqual(outcome.failure.reason, "unsupported-idempotency");
        }

        assert.strictEqual(yield* Queue.size(fixture.received), 0);
        assert.strictEqual(yield* Queue.size(backup.received), 0);
      }),
  );

  it.live.each(["keyMode", "messageRules", "automaticFooter"])(
    "requires truthful untyped construction attestation %s",
    (field) =>
      Effect.gen(function* rejectMailchimpAttestation() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 200,
        });

        const untyped = { ...options };
        Reflect.deleteProperty(untyped, field);

        const outcome = yield* Effect.service(Email).pipe(
          Effect.provide(
            mailchimpEmailLayer(untyped).pipe(
              Layer.provide(emailFixtureClientLayer(fixture.url, "https://mandrillapp.com")),
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

  it.live.each(["", "private key", "private\nkey", "private-κλειδί", "x".repeat(257)])(
    "rejects malformed Redacted credentials without leaking values",
    (apiKey) =>
      Effect.gen(function* rejectMailchimpCredential() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 200,
        });

        const outcome = yield* Effect.service(Email).pipe(
          Effect.provide(
            mailchimpEmailLayer({ ...options, apiKey: Redacted.make(apiKey) }).pipe(
              Layer.provide(emailFixtureClientLayer(fixture.url, "https://mandrillapp.com")),
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
