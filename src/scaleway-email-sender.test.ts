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
  EmailRecipientOutcomeSchema,
  EmailRejected,
  EmailRouter,
  EmailSender,
  emailRouterLayer,
  parseEmailMessage,
} from "./index.js";
import { scalewayEmailLayer, scalewaySenderLayer } from "./scaleway-email-sender.js";
import type { ScalewayEmailOptions } from "./scaleway-email-sender.js";
import { resendEmailLayer } from "./resend-email-sender.js";

const message = {
  body: { html: "<p>Synthetic café {{literal}}</p>", text: "Synthetic café {{literal}}" },
  from: { address: "sender@example.test", name: 'Fictional "Café"' },
  subject: "Synthetic Scaleway notification",
  to: ["recipient@example.test"],
} as const;

const options = {
  projectId: "33333333-3333-4333-8333-333333333333",
  secretKey: Redacted.make("fictional-scaleway-key"),
  tracking: "ProviderDisabled",
} as const;

const policy = {
  deadline: Duration.seconds(5),
  initialDelay: Duration.millis(100),
  maxAttempts: 3,
};

const recipientRecord = (recipient = "recipient@example.test", role = "to", index = 1) => ({
  id: `abcdefab-1111-4111-8111-${index.toString().padStart(12, "0")}`,
  mail_from: message.from.address,
  mail_rcpt: recipient,
  message_id: "22222222-2222-4222-8222-222222222222",
  project_id: options.projectId,
  rcpt_type: role,
  status: "new",
  subject: message.subject,
});

const acknowledgement = { emails: [recipientRecord()] };

const fixtureScalewayLayer = (fixture: EmailHttpFixture) =>
  scalewayEmailLayer(options, policy).pipe(
    Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.scaleway.com")),
  );

const fixtureScalewayRoute = (primary: EmailHttpFixture, backup: EmailHttpFixture) =>
  emailRouterLayer(
    [
      { layer: fixtureScalewayLayer(primary), name: "primary" },
      {
        layer: resendEmailLayer({ apiKey: Redacted.make("fictional-backup-key") }, policy).pipe(
          Layer.provide(emailFixtureClientLayer(backup.url, "https://api.resend.com")),
        ),
        name: "backup",
      },
    ],
    { fallbacks: ["backup"], primary: "primary" },
  );

const routedSend = Effect.gen(function* submitScalewayRoute() {
  return yield* (yield* (yield* EmailRouter).select()).send(message);
});

const ScalewayWire = Schema.Struct({
  additional_headers: Schema.Array(Schema.Struct({ key: Schema.String, value: Schema.String })),
  attachments: Schema.Array(
    Schema.Struct({ content: Schema.String, name: Schema.String, type: Schema.String }),
  ),
  bcc: Schema.Array(Schema.Struct({ email: Schema.String, name: Schema.String })),
  cc: Schema.Array(Schema.Struct({ email: Schema.String, name: Schema.String })),
  from: Schema.Struct({ email: Schema.String, name: Schema.String }),
  html: Schema.String,
  project_id: Schema.String,
  subject: Schema.String,
  text: Schema.String,
  to: Schema.Array(
    Schema.Struct({ email: Schema.String, name: Schema.optionalKey(Schema.String) }),
  ),
});

describe("Scaleway actual constrained transactional protocol", () => {
  it.live(
    "preserves structured group identity, reply lists, literal alternatives and explicit attachment bytes",
    () =>
      Effect.gen(function* inspectScalewayWire() {
        const records = [
          recipientRecord("hidden@example.test", "bcc", 4),
          recipientRecord("second@example.test", "to", 2),
          recipientRecord("copy@example.test", "cc", 3),
          recipientRecord("FIRST@example.test", "to", 1),
        ];

        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify({ emails: records }),
          status: 200,
        });

        const receipt = yield* Effect.gen(function* submitRichScalewayIntent() {
          return yield* (yield* Email).send({
            ...message,
            attachments: [
              { contentBase64: "AP+ACg==", contentType: "text/plain", filename: "sample.txt" },
            ],
            bcc: { address: "hidden@example.test", name: "Fictional Hidden" },
            cc: { address: "copy@example.test", name: "Fictional Copy" },
            headers: [{ name: "X-Workflow", value: "synthetic" }],
            replyTo: [
              { address: "reply@example.test", name: 'Reply "Café"' },
              "other-reply@example.test",
            ],
            to: [{ address: "first@example.test", name: "First Fictional" }, "second@example.test"],
          });
        }).pipe(Effect.provide(fixtureScalewayLayer(fixture)));

        assert(EmailReceiptSchema.guards.RecipientOutcomes(receipt));
        assert.deepStrictEqual(
          receipt.outcomes.map(({ recipient }) => String(recipient)),
          ["first@example.test", "second@example.test", "copy@example.test", "hidden@example.test"],
        );
        assert.deepStrictEqual(
          receipt.outcomes.map(({ messageId }) => String(messageId)),
          [records[3]?.id, records[1]?.id, records[2]?.id, records[0]?.id],
        );
        assert.isTrue(
          receipt.outcomes.every(
            (outcome) =>
              EmailRecipientOutcomeSchema.guards.Accepted(outcome) && Object.isFrozen(outcome),
          ),
        );
        assert.isTrue(Object.isFrozen(receipt));
        assert.isTrue(Object.isFrozen(receipt.outcomes));
        assert.strictEqual(receipt.messageId, "22222222-2222-4222-8222-222222222222");
        const sent = yield* Queue.take(fixture.received);
        assert.strictEqual(sent.path, "/transactional-email/v1alpha1/regions/fr-par/emails");
        assert.strictEqual(sent.method, "POST");
        assert.strictEqual(sent.scalewayToken, "fictional-scaleway-key");
        assert.strictEqual(sent.authorization, "");
        assert.strictEqual(sent.idempotencyKey, "");
        const wire = yield* Schema.decodeEffect(Schema.fromJsonString(ScalewayWire))(sent.body);
        assert.strictEqual(wire.project_id, options.projectId);
        assert.deepStrictEqual(wire.from, { email: message.from.address, name: message.from.name });
        assert.deepStrictEqual(wire.to, [
          { email: "first@example.test", name: "First Fictional" },
          { email: "second@example.test" },
        ]);
        assert.deepStrictEqual(wire.cc, [{ email: "copy@example.test", name: "Fictional Copy" }]);
        assert.deepStrictEqual(wire.bcc, [
          { email: "hidden@example.test", name: "Fictional Hidden" },
        ]);
        assert.strictEqual(wire.subject, message.subject);
        assert.strictEqual(wire.text, message.body.text);
        assert.strictEqual(wire.html, message.body.html);
        assert.deepStrictEqual(wire.additional_headers, [
          { key: "X-Workflow", value: "synthetic" },
          {
            key: "Reply-To",
            value: '"Reply \\"Café\\"" <reply@example.test>, other-reply@example.test',
          },
        ]);
        const [attachment] = wire.attachments;
        assert.isDefined(attachment);
        assert.strictEqual(attachment.type, "text/plain");
        assert.strictEqual(attachment.name, "sample.txt");
        assert.deepStrictEqual([...Buffer.from(attachment.content, "base64")], [0, 255, 128, 10]);
        assert.notInclude(sent.body, "send_before");
      }),
  );

  it.effect.each([1, 3, 10])(
    "restores %i recipients from unordered new/sending/sent records without backup or delivery claims",
    (total) =>
      Effect.gen(function* preserveScalewayAudience() {
        const addresses = [
          "first@example.test",
          ...Array.from({ length: total - 1 }, (_, index) => `member-${index}@example.test`),
        ];

        const records = addresses
          .map((address, index) => ({
            ...recipientRecord(address.toUpperCase(), "to", index + 1),
            status: ["new", "sending", "sent"][index % 3],
          }))
          .toReversed();

        const primary = yield* startEmailHttpFixture({
          body: JSON.stringify({ emails: records }),
          status: 200,
        });

        const backup = yield* startEmailHttpFixture({
          body: JSON.stringify({ id: "backup-id" }),
          status: 200,
        });

        const receipt = yield* Effect.gen(function* submitScalewayAudience() {
          return yield* (yield* (yield* EmailRouter).select()).send({
            ...message,
            to: ["first@example.test", ...addresses.slice(1)],
          });
        }).pipe(Effect.provide(fixtureScalewayRoute(primary, backup)));

        assert(EmailReceiptSchema.guards.RecipientOutcomes(receipt));
        assert.strictEqual(receipt.route, "primary");
        assert.strictEqual(receipt.messageId, "22222222-2222-4222-8222-222222222222");
        assert.deepStrictEqual(
          receipt.outcomes.map(({ recipient }) => String(recipient)),
          addresses,
        );
        assert.isTrue(
          receipt.outcomes.every(
            (outcome) =>
              EmailRecipientOutcomeSchema.guards.Accepted(outcome) && Object.isFrozen(outcome),
          ),
        );
        assert.isTrue(Object.isFrozen(receipt.outcomes));
        assert.strictEqual(yield* Queue.size(primary.received), 1);
        assert.strictEqual(yield* Queue.size(backup.received), 0);
      }),
  );

  it.live.each([
    {},
    { emails: [] },
    { emails: [recipientRecord(), recipientRecord()] },
    { emails: [{ ...recipientRecord(), mail_rcpt: "foreign@example.test" }] },
    { emails: [{ ...recipientRecord(), rcpt_to: "foreign@example.test" }] },
    { emails: [{ ...recipientRecord(), mail_from: "foreign@example.test" }] },
    { emails: [{ ...recipientRecord(), project_id: "44444444-4444-4444-8444-444444444444" }] },
    { emails: [{ ...recipientRecord(), rcpt_type: "cc" }] },
    { emails: [{ ...recipientRecord(), subject: "private-foreign-subject" }] },
    { emails: [{ ...recipientRecord(), id: "not-a-uuid" }] },
    { emails: [{ ...recipientRecord(), message_id: "not-a-uuid" }] },
    { emails: [{ ...recipientRecord(), flags: ["blocklisted"], status: "failed" }] },
    { emails: [{ ...recipientRecord(), status: "canceled" }] },
    { emails: [{ ...recipientRecord(), status: "unknown" }] },
    { emails: [recipientRecord()], type: "private-error" },
    {
      emails: Array.from({ length: 11 }, (_, index) =>
        recipientRecord(`member-${index}@example.test`, "to", index + 1),
      ),
    },
  ])(
    "keeps incomplete, foreign, contradictory and terminal-lifecycle acknowledgement unknown (%j)",
    (body) =>
      Effect.gen(function* refuseScalewayProof() {
        const primary = yield* startEmailHttpFixture({ body: JSON.stringify(body), status: 200 });

        const backup = yield* startEmailHttpFixture({
          body: JSON.stringify({ id: "backup-id" }),
          status: 200,
        });

        const result = yield* routedSend.pipe(
          Effect.provide(fixtureScalewayRoute(primary, backup)),
          Effect.result,
        );

        assert(Result.isFailure(result));
        assert(result.failure instanceof EmailDeliveryUnknown);
        assert.strictEqual(result.failure.reason, "invalid-response");
        assert.notInclude(JSON.stringify(result.failure), "private-");
        assert.strictEqual(yield* Queue.size(primary.received), 1);
        assert.strictEqual(yield* Queue.size(backup.received), 0);
      }),
  );

  it.live.each([302, 400, 401, 403, 409, 422, 429, 500, 503, 504])(
    "does not borrow fallback or replay from unreviewed status %s",
    (status) =>
      Effect.gen(function* refuseScalewayStatusAuthority() {
        const primary = yield* startEmailHttpFixture({
          body: JSON.stringify({
            ...acknowledgement,
            message: "private-server-reason",
            type: "invalid_auth",
          }),
          status,
        });

        const backup = yield* startEmailHttpFixture({
          body: JSON.stringify({ id: "backup-id" }),
          status: 200,
        });

        const result = yield* routedSend.pipe(
          Effect.provide(fixtureScalewayRoute(primary, backup)),
          Effect.result,
        );

        assert(Result.isFailure(result));
        assert(result.failure instanceof EmailDeliveryUnknown);
        assert.strictEqual(
          result.failure.reason,
          status >= 500 ? "server-error" : "unexpected-status",
        );
        assert.strictEqual(result.failure.status, status);
        assert.notInclude(JSON.stringify(result.failure), "private-server-reason");
        assert.strictEqual(yield* Queue.size(primary.received), 1);
        assert.strictEqual(yield* Queue.size(backup.received), 0);
      }),
  );

  it.live(
    "requires complete recipient coverage, unique resource IDs and shared-message correlation",
    () =>
      Effect.gen(function* correlateScalewayRecords() {
        for (const records of [
          [recipientRecord()],
          [
            recipientRecord(),
            { ...recipientRecord("copy@example.test", "cc", 2), id: recipientRecord().id },
          ],
          [
            recipientRecord(),
            {
              ...recipientRecord("copy@example.test", "cc", 2),
              id: recipientRecord().id.toUpperCase(),
            },
          ],
          [
            recipientRecord(),
            {
              ...recipientRecord("copy@example.test", "cc", 2),
              message_id: "55555555-5555-4555-8555-555555555555",
            },
          ],
        ]) {
          const fixture = yield* startEmailHttpFixture({
            body: JSON.stringify({ emails: records }),
            status: 200,
          });

          const result = yield* Effect.gen(function* submitScalewayCopies() {
            return yield* (yield* Email).send({ ...message, cc: "copy@example.test" });
          }).pipe(Effect.provide(fixtureScalewayLayer(fixture)), Effect.result);

          assert(Result.isFailure(result));
          assert(result.failure instanceof EmailDeliveryUnknown);
          assert.strictEqual(yield* Queue.size(fixture.received), 1);
        }
      }),
  );

  it.live.each([
    { ...message, subject: "short" },
    { ...message, body: { text: "short" } },
    { ...message, body: { html: "<p>x</p>" } },
    { ...message, body: { text: "😀".repeat(5) } },
    { ...message, to: ["recipient@example.test", "RECIPIENT@example.test"] },
    { ...message, cc: "RECIPIENT@example.test" },
    {
      ...message,
      to: [
        "first@example.test",
        ...Array.from({ length: 10 }, (_, index) => `member-${index}@example.test`),
      ],
    },
    { ...message, headers: [{ name: "X-Auth-Token", value: "private-token" }] },
    { ...message, headers: [{ name: "X-Send-Before", value: "private-time" }] },
    { ...message, headers: [{ name: "X-Scw-Tracking", value: "private-control" }] },
    {
      ...message,
      headers: [
        { name: "X-Workflow", value: "first" },
        { name: "x-workflow", value: "second" },
      ],
    },
    {
      ...message,
      attachments: [
        { contentBase64: "AQ==", contentType: "ProviderSelected", filename: "sample.txt" },
      ],
    },
    {
      ...message,
      attachments: [
        { contentBase64: "AQ==", contentType: "application/octet-stream", filename: "sample.dat" },
      ],
    },
    {
      ...message,
      attachments: [
        { contentBase64: "AQ==", contentType: "application/zip", filename: "sample.zip" },
      ],
    },
    {
      ...message,
      attachments: [
        {
          contentBase64: "AQ==",
          contentId: "sample",
          contentType: "image/png",
          filename: "sample.png",
        },
      ],
    },
    { ...message, sendAt: "2026-10-14T12:30:00Z" },
    { ...message, metadata: { workflow: "private-value" } },
    { ...message, tags: [{ name: "workflow", value: "private-value" }] },
    { ...message, body: { html: "界".repeat(700_000) } },
  ] as const)(
    "rejects nonrepresentable intent across every route before transport (case %#)",
    (input) =>
      Effect.gen(function* preflightScalewayIntent() {
        const primary = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 200,
        });

        const backup = yield* startEmailHttpFixture({
          body: JSON.stringify({ id: "backup-id" }),
          status: 200,
        });

        const results = yield* Effect.gen(function* validateAndSubmitScalewayIntent() {
          const email = yield* (yield* EmailRouter).select();

          return [
            yield* email.validate(input).pipe(Effect.asVoid, Effect.result),
            yield* email.send(input).pipe(Effect.asVoid, Effect.result),
          ];
        }).pipe(Effect.provide(fixtureScalewayRoute(primary, backup)));

        for (const result of results) {
          assert(Result.isFailure(result));
          assert(result.failure instanceof EmailInvalidMessage);
          assert.notInclude(JSON.stringify(result.failure), "private-");
        }

        assert.strictEqual(yield* Queue.size(primary.received), 0);
        assert.strictEqual(yield* Queue.size(backup.received), 0);
      }),
  );

  it.live("preserves a single body alternative at the Unicode content minimum", () =>
    Effect.gen(function* preserveScalewaySingleAlternatives() {
      const fixture = yield* startEmailHttpFixture({
        body: JSON.stringify(acknowledgement),
        status: 200,
      });

      yield* Effect.gen(function* submitScalewaySingleAlternatives() {
        const email = yield* Email;

        for (const body of [{ text: "界".repeat(10) }, { html: "界".repeat(10) }]) {
          const receipt = yield* email.send({ ...message, body });
          assert(EmailReceiptSchema.guards.RecipientOutcomes(receipt));
          const sent = yield* Queue.take(fixture.received);

          const wire = yield* Schema.decodeEffect(
            Schema.fromJsonString(
              Schema.Struct({
                html: Schema.optionalKey(Schema.String),
                text: Schema.optionalKey(Schema.String),
              }),
            ),
          )(sent.body);

          assert.deepStrictEqual(wire, body);
        }
      }).pipe(Effect.provide(fixtureScalewayLayer(fixture)));
    }),
  );

  it.live("enforces the conservative UTF-8 whole-request budget without dropping content", () =>
    Effect.gen(function* boundScalewayWireBytes() {
      const fixture = yield* startEmailHttpFixture({
        body: JSON.stringify(acknowledgement),
        status: 200,
      });

      yield* Effect.gen(function* submitScalewayWireBoundary() {
        const email = yield* Email;
        const baseline = { ...message, body: { html: "0123456789" } };
        yield* email.send(baseline);
        const first = yield* Queue.take(fixture.received);
        const available = 1_900_000 - new TextEncoder().encode(first.body).byteLength + 10;
        const html = "界".repeat(Math.floor(available / 3)) + "x".repeat(available % 3);
        const receipt = yield* email.send({ ...baseline, body: { html } });
        assert(EmailReceiptSchema.guards.RecipientOutcomes(receipt));
        const sent = yield* Queue.take(fixture.received);
        assert.strictEqual(new TextEncoder().encode(sent.body).byteLength, 1_900_000);

        const wire = yield* Schema.decodeEffect(
          Schema.fromJsonString(Schema.Struct({ html: Schema.String })),
        )(sent.body);

        assert.strictEqual(wire.html, html);

        const result = yield* email
          .send({ ...baseline, body: { html: `${html}x` } })
          .pipe(Effect.result);

        assert(Result.isFailure(result));
        assert(result.failure instanceof EmailInvalidMessage);
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }).pipe(Effect.provide(fixtureScalewayLayer(fixture)));
    }),
  );

  it.live("rejects unsupported keys in ordinary, routed and direct submissions before HTTP", () =>
    Effect.gen(function* defendScalewayKeys() {
      const primary = yield* startEmailHttpFixture({
        body: JSON.stringify(acknowledgement),
        status: 200,
      });

      const backup = yield* startEmailHttpFixture({
        body: JSON.stringify({ id: "backup-id" }),
        status: 200,
      });

      const ordinary = yield* Effect.gen(function* submitOrdinaryScalewayKey() {
        return yield* (yield* Email).send(message, { idempotencyKey: "private-key" });
      }).pipe(Effect.provide(fixtureScalewayLayer(primary)), Effect.result);

      const routed = yield* Effect.gen(function* submitRoutedScalewayKey() {
        return yield* (yield* (yield* EmailRouter).select()).send(message, {
          idempotencyKey: "private-key",
        });
      }).pipe(Effect.provide(fixtureScalewayRoute(primary, backup)), Effect.result);

      const direct = yield* Effect.gen(function* submitDirectScalewayKey() {
        return yield* (yield* EmailSender).submit({
          idempotencyKey: EmailIdempotencyKeySchema.make("private-key"),
          message: yield* parseEmailMessage(message),
        });
      }).pipe(
        Effect.provide(
          scalewaySenderLayer(options).pipe(
            Layer.provide(emailFixtureClientLayer(primary.url, "https://api.scaleway.com")),
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

      assert.strictEqual(yield* Queue.size(primary.received), 0);
      assert.strictEqual(yield* Queue.size(backup.received), 0);
    }),
  );

  it.live.each(["", "private key", "private\r\nkey"])(
    "refuses malformed credentials without retaining private values (%j)",
    (credential) =>
      Effect.gen(function* refuseScalewayCredential() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 200,
        });

        const result = yield* Effect.service(Email).pipe(
          Effect.provide(
            scalewayEmailLayer({ ...options, secretKey: Redacted.make(credential) }).pipe(
              Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.scaleway.com")),
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
    "requires valid project identity and explicit tracking attestation without remote acquisition",
    () =>
      Effect.gen(function* requireScalewayConfiguration() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 200,
        });

        const missing = { ...options };
        Reflect.deleteProperty(missing, "tracking");

        for (const configuration of [
          missing,
          { ...options, projectId: "private-invalid-project" },
        ]) {
          const result = yield* Effect.service(Email).pipe(
            Effect.provide(
              scalewayEmailLayer(configuration).pipe(
                Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.scaleway.com")),
              ),
            ),
            Effect.result,
          );

          assert(Result.isFailure(result));
          assert(result.failure instanceof EmailConfigurationError);
          assert.notInclude(JSON.stringify(result.failure), "private-invalid-project");
        }

        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );

  it.live("owns construction identity and credentials once acquired", () =>
    Effect.gen(function* ownScalewayConfiguration() {
      const fixture = yield* startEmailHttpFixture({
        body: JSON.stringify(acknowledgement),
        status: 200,
      });

      const configuration = {
        projectId: "33333333-3333-4333-8333-333333333333",
        secretKey: options.secretKey,
        tracking: "ProviderDisabled",
      } satisfies ScalewayEmailOptions;

      yield* Effect.gen(function* mutateScalewayOptionsAfterAcquisition() {
        const email = yield* Email;
        configuration.projectId = "44444444-4444-4444-8444-444444444444";
        configuration.secretKey = Redacted.make("private-mutated-key");
        const receipt = yield* email.send(message);
        assert(EmailReceiptSchema.guards.RecipientOutcomes(receipt));
      }).pipe(
        Effect.provide(
          scalewayEmailLayer(configuration).pipe(
            Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.scaleway.com")),
          ),
        ),
      );
      const sent = yield* Queue.take(fixture.received);
      assert.strictEqual(sent.scalewayToken, "fictional-scaleway-key");
      assert.include(sent.body, options.projectId);
      assert.notInclude(sent.body, configuration.projectId);
    }),
  );
});
