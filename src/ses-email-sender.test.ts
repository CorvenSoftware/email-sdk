import { webcrypto } from "node:crypto";
import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Fiber, Layer, Queue, Redacted, Result, Schema, Tracer } from "effect";
import { TestClock } from "effect/testing";
import { emailFixtureClientLayer, startEmailHttpFixture } from "../test/email-http-fixture.js";
import type { EmailHttpFixture, ReceivedEmailHttpSubmission } from "../test/email-http-fixture.js";
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
import { sesEmailLayer, sesSenderLayer } from "./ses-email-sender.js";
import type { SesEmailOptions } from "./ses-email-sender.js";
import { resendEmailLayer } from "./resend-email-sender.js";

const options = {
  accessKeyId: Redacted.make("AKIAFICTIONALEXAMPLE1"),
  mailFlow: "ProviderUnmodified",
  region: "us-east-1",
  secretAccessKey: Redacted.make("fictional-secret-access-key"),
  sessionToken: Redacted.make("fictional/session+token=="),
} as const;

const message = {
  body: { html: "<p>Literal café {{name}}</p>", text: "Literal café {{name}}" },
  from: { address: "sender@example.test", name: "Fictional Sender" },
  subject: "Synthetic SES notification",
  to: "recipient@example.test",
} as const;

const policy = {
  deadline: Duration.seconds(5),
  initialDelay: Duration.millis(100),
  maxAttempts: 3,
};

const acknowledgement = { MessageId: "fictional-ses-message-id" };

const fixtureSesLayer = (fixture: EmailHttpFixture, configuration: SesEmailOptions = options) =>
  sesEmailLayer(configuration, policy).pipe(
    Layer.provide(
      emailFixtureClientLayer(fixture.url, `https://email.${configuration.region}.amazonaws.com`),
    ),
  );

const fixtureRoute = (primary: EmailHttpFixture, backup: EmailHttpFixture) =>
  emailRouterLayer(
    [
      { layer: fixtureSesLayer(primary), name: "primary" },
      {
        layer: resendEmailLayer({ apiKey: Redacted.make("fictional-backup") }, policy).pipe(
          Layer.provide(emailFixtureClientLayer(backup.url, "https://api.resend.com")),
        ),
        name: "backup",
      },
    ],
    { fallbacks: ["backup"], primary: "primary" },
  );

const verifySesWireSignature = Effect.fnUntraced(function* verifySesWireSignature(
  sent: ReceivedEmailHttpSubmission,
  region: SesEmailOptions["region"],
) {
  const credentials =
    /^AWS4-HMAC-SHA256 Credential=(?<accessKey>[^/]+)\/(?<date>\d{8})\/(?<signedRegion>[^/]+)\/ses\/aws4_request, SignedHeaders=(?<names>[a-z0-9;-]+), Signature=(?<signature>[a-f0-9]{64})$/u.exec(
      sent.authorization,
    );

  assert(credentials?.groups !== undefined);
  const { accessKey, date, signedRegion, names, signature } = credentials.groups;
  assert(
    accessKey !== undefined &&
      date !== undefined &&
      signedRegion !== undefined &&
      names !== undefined &&
      signature !== undefined,
  );
  assert.strictEqual(accessKey, "AKIAFICTIONALEXAMPLE1");
  assert.strictEqual(signedRegion, region);
  assert.strictEqual(date, sent.sesDate.slice(0, 8));
  assert.strictEqual(sent.sesSigningHost, `email.${region}.amazonaws.com`);
  assert.match(sent.host, /^127\.0\.0\.1:/u);
  assert.strictEqual(sent.path, "/v2/email/outbound-emails");
  assert.strictEqual(sent.method, "POST");
  assert.strictEqual(sent.contentType, "application/json");
  const bytes = new Uint8Array(Buffer.from(sent.bodyBase64, "base64"));

  const digest = yield* Effect.promise(
    webcrypto.subtle.digest.bind(webcrypto.subtle, "SHA-256", bytes),
  );

  const payloadHash = Buffer.from(digest).toString("hex");
  assert.strictEqual(sent.sesPayloadHash, payloadHash);

  const headers = new Map([
    ["content-type", sent.contentType],
    ["host", sent.sesSigningHost],
    ["x-amz-date", sent.sesDate],
    ["x-amz-content-sha256", sent.sesPayloadHash],
    ["x-amz-security-token", sent.sesSessionToken],
  ]);

  const headerNames = names.split(";");
  assert.deepStrictEqual(headerNames, headerNames.toSorted());

  for (const required of ["content-type", "host", "x-amz-date", "x-amz-content-sha256"]) {
    assert.include(headerNames, required);
  }

  assert.strictEqual(headerNames.includes("x-amz-security-token"), sent.sesSessionToken.length > 0);

  const canonicalHeaders = headerNames
    .map((name) => {
      const value = headers.get(name);
      assert(value !== undefined);

      return `${name}:${value.trim().replaceAll(/\s+/gu, " ")}\n`;
    })
    .join("");

  const canonical = `${sent.method}\n${sent.path}\n\n${canonicalHeaders}\n${names}\n${payloadHash}`;

  const canonicalHash = yield* Effect.promise(
    webcrypto.subtle.digest.bind(webcrypto.subtle, "SHA-256", new TextEncoder().encode(canonical)),
  );

  const stringToSign = `AWS4-HMAC-SHA256\n${sent.sesDate}\n${date}/${region}/ses/aws4_request\n${Buffer.from(canonicalHash).toString("hex")}`;
  let key: ArrayBuffer = new TextEncoder().encode("AWS4fictional-secret-access-key").buffer;

  for (const part of [date, region, "ses", "aws4_request", stringToSign]) {
    const imported = yield* Effect.promise(
      webcrypto.subtle.importKey.bind(
        webcrypto.subtle,
        "raw",
        key,
        { hash: "SHA-256", name: "HMAC" },
        false,
        ["sign"],
      ),
    );

    key = yield* Effect.promise(
      webcrypto.subtle.sign.bind(
        webcrypto.subtle,
        "HMAC",
        imported,
        new TextEncoder().encode(part),
      ),
    );
  }

  assert.strictEqual(signature, Buffer.from(key).toString("hex"));
});

const SesWire = Schema.Struct({
  ConfigurationOverrides: Schema.Struct({
    Tracking: Schema.Struct({
      ClickTrackingEnabled: Schema.String,
      OpenTrackingEnabled: Schema.String,
    }),
  }),
  Content: Schema.Struct({
    Simple: Schema.Struct({
      Attachments: Schema.Array(
        Schema.Struct({
          ContentDisposition: Schema.String,
          ContentId: Schema.optionalKey(Schema.String),
          ContentTransferEncoding: Schema.String,
          ContentType: Schema.String,
          FileName: Schema.String,
          RawContent: Schema.String,
        }),
      ),
      Body: Schema.Struct({
        Html: Schema.Struct({ Charset: Schema.String, Data: Schema.String }),
        Text: Schema.Struct({ Charset: Schema.String, Data: Schema.String }),
      }),
      Headers: Schema.Array(Schema.Struct({ Name: Schema.String, Value: Schema.String })),
      Subject: Schema.Struct({ Charset: Schema.String, Data: Schema.String }),
    }),
  }),
  Destination: Schema.Struct({
    BccAddresses: Schema.Array(Schema.String),
    CcAddresses: Schema.Array(Schema.String),
    ToAddresses: Schema.Array(Schema.String),
  }),
  EmailTags: Schema.Array(Schema.Struct({ Name: Schema.String, Value: Schema.String })),
  FromEmailAddress: Schema.String,
  ReplyToAddresses: Schema.Array(Schema.String),
});

describe("SES constrained regional simple sends", () => {
  it.live.each(["us-east-1", "us-west-2", "eu-west-1"] as const)(
    "signs actual UTF-8 JSON bytes for %s and retains literal groups/MIME/CID without tracking",
    (region) =>
      Effect.gen(function* inspectSesWire() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 200,
        });

        const input = {
          ...message,
          attachments: [
            { contentBase64: "AP+ACg==", contentType: "application/pdf", filename: "report.pdf" },
            {
              contentBase64: "AQID",
              contentId: "separate-logo",
              contentType: "image/png",
              filename: "logo.png",
            },
          ],
          bcc: { address: "hidden@example.test", name: "Hidden" },
          cc: "copy@example.test",
          headers: [{ name: "X-Workflow", value: "literal-123" }],
          replyTo: ["reply@example.test", { address: "other-reply@example.test", name: "Other" }],
          tags: [{ name: "workflow", value: "notification_1" }],
          to: [message.to, { address: "second@example.test", name: 'Second "Person"' }],
        } as const;

        const receipt = yield* Effect.gen(function* sendSesRich() {
          return yield* (yield* Email).send(input);
        }).pipe(Effect.provide(fixtureSesLayer(fixture, { ...options, region })));

        assert(EmailReceiptSchema.guards.Accepted(receipt));
        assert.strictEqual(receipt.messageId, "fictional-ses-message-id");
        assert.isTrue(Object.isFrozen(receipt));
        const sent = yield* Queue.take(fixture.received);
        yield* verifySesWireSignature(sent, region);
        assert.strictEqual(sent.sesSessionToken, "fictional/session+token==");
        assert.strictEqual(sent.idempotencyKey, "");
        const wire = yield* Schema.decodeEffect(Schema.fromJsonString(SesWire))(sent.body);
        assert.strictEqual(wire.FromEmailAddress, '"Fictional Sender" <sender@example.test>');
        assert.deepStrictEqual(wire.Destination.ToAddresses, [
          message.to,
          '"Second \\"Person\\"" <second@example.test>',
        ]);
        assert.deepStrictEqual(wire.Destination.CcAddresses, [input.cc]);
        assert.deepStrictEqual(wire.Destination.BccAddresses, ['"Hidden" <hidden@example.test>']);
        assert.deepStrictEqual(wire.ReplyToAddresses, [
          input.replyTo[0],
          '"Other" <other-reply@example.test>',
        ]);
        const simple = wire.Content.Simple;
        assert.strictEqual(simple.Subject.Data, input.subject);
        assert.strictEqual(simple.Subject.Charset, "utf-8");
        assert.strictEqual(simple.Body.Text.Data, input.body.text);
        assert.strictEqual(simple.Body.Html.Data, input.body.html);
        assert.strictEqual(simple.Body.Text.Charset, "utf-8");
        assert.strictEqual(simple.Body.Html.Charset, "utf-8");
        assert.deepStrictEqual(simple.Headers, [{ Name: "X-Workflow", Value: "literal-123" }]);
        assert.deepStrictEqual(wire.EmailTags, [{ Name: "workflow", Value: "notification_1" }]);
        assert.strictEqual(wire.ConfigurationOverrides.Tracking.ClickTrackingEnabled, "DISABLED");
        assert.strictEqual(wire.ConfigurationOverrides.Tracking.OpenTrackingEnabled, "DISABLED");
        const [ordinary, inline] = simple.Attachments;
        assert(ordinary !== undefined && inline !== undefined);
        assert.deepStrictEqual([...Buffer.from(ordinary.RawContent, "base64")], [0, 255, 128, 10]);
        assert.strictEqual(ordinary.FileName, "report.pdf");
        assert.strictEqual(ordinary.ContentType, "application/pdf");
        assert.strictEqual(ordinary.ContentDisposition, "ATTACHMENT");
        assert.strictEqual(ordinary.ContentTransferEncoding, "BASE64");
        assert.isUndefined(ordinary.ContentId);
        assert.deepStrictEqual([...Buffer.from(inline.RawContent, "base64")], [1, 2, 3]);
        assert.strictEqual(inline.ContentId, "separate-logo");
        assert.strictEqual(inline.FileName, "logo.png");
        assert.strictEqual(inline.ContentType, "image/png");
        assert.strictEqual(inline.ContentDisposition, "INLINE");
        assert.strictEqual(inline.ContentTransferEncoding, "BASE64");
      }),
  );

  it.effect(
    "uses Effect's clock without acquiring or inventing a session token for long-lived credentials",
    () =>
      Effect.gen(function* clockSesSigning() {
        yield* TestClock.setTime(1_793_491_199_000);

        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 200,
        });

        const configuration = {
          accessKeyId: options.accessKeyId,
          mailFlow: options.mailFlow,
          region: options.region,
          secretAccessKey: options.secretAccessKey,
        };

        yield* Effect.gen(function* sendSesLongLived() {
          return yield* (yield* Email).send(message);
        }).pipe(Effect.provide(fixtureSesLayer(fixture, configuration)));
        const sent = yield* Queue.take(fixture.received);
        assert.strictEqual(sent.sesDate, "20261031T235959Z");
        assert.strictEqual(sent.sesSessionToken, "");
        yield* verifySesWireSignature(sent, options.region);
      }),
  );

  it.effect(
    "preserves Unicode, JSON escapes and template-like body literals in the signed request",
    () =>
      Effect.gen(function* literalSesContent() {
        const literal = 'café 界😀 "quoted" \\ <>&\n{{name}} %recipient.name% *|UNSUB|*';

        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 200,
        });

        yield* Effect.gen(function* sendSesLiteral() {
          return yield* (yield* Email).send({
            ...message,
            body: { html: `<p>{{name}} ${literal}</p>`, text: literal },
          });
        }).pipe(Effect.provide(fixtureSesLayer(fixture)));
        const sent = yield* Queue.take(fixture.received);

        const wire = yield* Schema.decodeEffect(
          Schema.fromJsonString(
            Schema.Struct({
              Content: Schema.Struct({
                Simple: Schema.Struct({
                  Body: Schema.Struct({
                    Html: Schema.Struct({ Data: Schema.String }),
                    Text: Schema.Struct({ Data: Schema.String }),
                  }),
                }),
              }),
            }),
          ),
        )(sent.body);

        assert.strictEqual(wire.Content.Simple.Body.Text.Data, literal);
        assert.strictEqual(wire.Content.Simple.Body.Html.Data, `<p>{{name}} ${literal}</p>`);
        yield* verifySesWireSignature(sent, options.region);
      }),
  );

  it.live.each([
    { body: {}, status: 200 },
    { body: { MessageId: "" }, status: 200 },
    { body: { MessageId: "private id" }, status: 200 },
    { body: { ...acknowledgement, error: "private" }, status: 200 },
    { body: acknowledgement, status: 202 },
    { body: acknowledgement, status: 500 },
    { body: acknowledgement, status: 503 },
    { body: { message: "private" }, status: 401 },
    { body: { message: "private" }, status: 429 },
  ])(
    "never replays or falls back on missing/incoherent/unreviewed submission evidence (case %#)",
    ({ body, status }) =>
      Effect.gen(function* unknownSesOutcome() {
        const primary = yield* startEmailHttpFixture({ body: JSON.stringify(body), status });

        const backup = yield* startEmailHttpFixture({
          body: JSON.stringify({ id: "backup" }),
          status: 200,
        });

        const result = yield* Effect.gen(function* routeSesUnknown() {
          return yield* (yield* (yield* EmailRouter).select()).send(message);
        }).pipe(Effect.provide(fixtureRoute(primary, backup)), Effect.result);

        assert(Result.isFailure(result) && result.failure instanceof EmailDeliveryUnknown);
        assert.notInclude(JSON.stringify(result.failure), "private");
        assert.strictEqual(yield* Queue.size(primary.received), 1);
        assert.strictEqual(yield* Queue.size(backup.received), 0);
      }),
  );

  it.live.each([
    { errorType: "AccessDeniedException", status: 403 },
    { errorType: "ExpiredTokenException", status: 403 },
    { errorType: "MailFromDomainNotVerifiedException", status: 400 },
    { errorType: "AccountSuspendedException", status: 400 },
    { errorType: "SendingPausedException", status: 400 },
  ])(
    "allows explicit fallback only on coherent definite regional refusal (case %#)",
    ({ errorType, status }) =>
      Effect.gen(function* routeSesRefusal() {
        const primary = yield* startEmailHttpFixture({
          body: JSON.stringify({ __type: errorType, message: "private reason" }),
          sesErrorType: errorType,
          status,
        });

        const backup = yield* startEmailHttpFixture({
          body: JSON.stringify({ id: "backup" }),
          status: 200,
        });

        const receipt = yield* Effect.gen(function* routeSesRejected() {
          return yield* (yield* (yield* EmailRouter).select()).send(message);
        }).pipe(Effect.provide(fixtureRoute(primary, backup)));

        assert(EmailReceiptSchema.guards.Accepted(receipt));
        assert.strictEqual(receipt.route, "backup");
        assert.strictEqual(yield* Queue.size(primary.received), 1);
        assert.strictEqual(yield* Queue.size(backup.received), 1);
      }),
  );

  it.effect(
    "waits for rate refusal, retains intent/account and freshly signs after midnight without token refresh",
    () =>
      Effect.gen(function* retrySesRate() {
        yield* TestClock.setTime(1_793_491_199_000);

        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify({ message: "private reason" }),
          next: { body: JSON.stringify(acknowledgement), status: 200 },
          retryAfter: "2",
          sesErrorType: "TooManyRequestsException",
          status: 429,
        });

        const mutable = { ...message, body: { ...message.body } };

        const fiber = yield* Effect.gen(function* sendSesRate() {
          return yield* (yield* Email).send(mutable);
        }).pipe(Effect.provide(fixtureSesLayer(fixture)), Effect.forkChild);

        const first = yield* Queue.take(fixture.received);
        Reflect.set(mutable.body, "text", "private-mutated-text");
        Reflect.set(mutable.body, "html", "<p>private-mutated-html</p>");
        yield* TestClock.adjust(Duration.millis(1999));
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
        yield* TestClock.adjust(Duration.seconds(1));
        const receipt = yield* Fiber.join(fiber);
        assert(EmailReceiptSchema.guards.Accepted(receipt));
        const second = yield* Queue.take(fixture.received);
        assert.strictEqual(second.body, first.body);
        assert.strictEqual(second.sesSessionToken, first.sesSessionToken);
        assert.notStrictEqual(second.sesDate.slice(0, 8), first.sesDate.slice(0, 8));
        assert.notStrictEqual(second.authorization, first.authorization);
        yield* verifySesWireSignature(first, options.region);
        yield* verifySesWireSignature(second, options.region);
      }),
  );

  it.live.each([
    { body: "not-json", sesErrorType: "AccessDeniedException", status: 403 },
    {
      body: JSON.stringify({ message: "private".repeat(10_000) }),
      sesErrorType: "AccessDeniedException",
      status: 403,
    },
    {
      body: JSON.stringify({ MessageId: "submitted", message: "private" }),
      sesErrorType: "AccessDeniedException",
      status: 403,
    },
    {
      body: JSON.stringify({ __type: "ExpiredTokenException", message: "private" }),
      sesErrorType: "AccessDeniedException",
      status: 403,
    },
    {
      body: JSON.stringify({ message: "private" }),
      sesErrorType: "AccessDeniedException",
      status: 429,
    },
    {
      body: JSON.stringify({ message: "private" }),
      sesErrorType: "TooManyRequestsException",
      status: 400,
    },
    { body: JSON.stringify({ message: "private" }), sesErrorType: "MessageRejected", status: 400 },
  ])(
    "does not derive retry/fallback from malformed, contradictory or unsupported refusal evidence (case %#)",
    (reply) =>
      Effect.gen(function* refuseSesUnsafeProof() {
        const primary = yield* startEmailHttpFixture(reply);

        const backup = yield* startEmailHttpFixture({
          body: JSON.stringify({ id: "backup" }),
          status: 200,
        });

        const result = yield* Effect.gen(function* routeSesBadProof() {
          return yield* (yield* (yield* EmailRouter).select()).send(message);
        }).pipe(Effect.provide(fixtureRoute(primary, backup)), Effect.result);

        assert(Result.isFailure(result) && result.failure instanceof EmailDeliveryUnknown);
        assert.notInclude(JSON.stringify(result.failure), "private");
        assert.strictEqual(yield* Queue.size(primary.received), 1);
        assert.strictEqual(yield* Queue.size(backup.received), 0);
      }),
  );

  it.live.each([
    { ...message, subject: "Unicode café" },
    { ...message, subject: "=?utf-8?b?Y2Fmw6k=?=" },
    { ...message, to: { address: message.to, name: "=?utf-8?b?Y2Fmw6k=?=" } },
    { ...message, from: { address: "sender@example.test", name: "Café" } },
    { ...message, to: [message.to, message.to.toUpperCase()] },
    { ...message, metadata: { private: "value" } },
    { ...message, sendAt: "2026-10-14T12:30:00Z" },
    { ...message, headers: [{ name: "X-SES-CONFIGURATION-SET", value: "private" }] },
    { ...message, headers: [{ name: "X-Amz-Authorization", value: "private" }] },
    { ...message, headers: [{ name: "Message-ID", value: "private" }] },
    { ...message, headers: [{ name: "X-Workflow", value: "café" }] },
    { ...message, headers: [{ name: "X-Workflow", value: "a".repeat(987) }] },
    {
      ...message,
      headers: [
        { name: "X-H0", value: "private" },
        ...Array.from({ length: 15 }, (_, index) => ({
          name: `X-H${index + 1}`,
          value: "private",
        })),
      ],
    },
    { ...message, tags: [{ name: "workflow", value: "private:reason" }] },
    {
      ...message,
      attachments: [
        { contentBase64: "AQID", contentType: "ProviderSelected", filename: "private.dat" },
      ],
    },
    {
      ...message,
      attachments: [
        { contentBase64: "AQID", contentType: "application/octet-stream", filename: "private.exe" },
      ],
    },
    {
      ...message,
      attachments: [
        {
          contentBase64: "AQID",
          contentId: "a".repeat(79),
          contentType: "image/png",
          filename: "private.png",
        },
      ],
    },
  ] as const)("refuses incompatible intent before signing/HTTP (case %#)", (input) =>
    Effect.gen(function* preflightSesIntent() {
      const fixture = yield* startEmailHttpFixture({
        body: JSON.stringify(acknowledgement),
        status: 200,
      });

      const result = yield* Effect.gen(function* sendSesInvalid() {
        return yield* (yield* Email).send(input);
      }).pipe(Effect.provide(fixtureSesLayer(fixture)), Effect.result);

      assert(Result.isFailure(result) && result.failure instanceof EmailInvalidMessage);
      assert.notInclude(JSON.stringify(result.failure), "private");
      assert.strictEqual(yield* Queue.size(fixture.received), 0);
    }),
  );

  it.live("preserves exact fifteen-header/combined-length bounds rather than truncating", () =>
    Effect.gen(function* boundSesHeaders() {
      const fixture = yield* startEmailHttpFixture({
        body: JSON.stringify(acknowledgement),
        status: 200,
      });

      const headers = [
        { name: "X-Workflow", value: "a".repeat(986) },
        ...Array.from({ length: 14 }, (_, index) => ({ name: `X-H${index}`, value: "value" })),
      ] as const;

      yield* Effect.gen(function* sendBoundedSesHeaders() {
        return yield* (yield* Email).send({ ...message, headers });
      }).pipe(Effect.provide(fixtureSesLayer(fixture)));
      const sent = yield* Queue.take(fixture.received);

      const wire = yield* Schema.decodeEffect(
        Schema.fromJsonString(
          Schema.Struct({
            Content: Schema.Struct({
              Simple: Schema.Struct({
                Headers: Schema.Array(Schema.Struct({ Name: Schema.String, Value: Schema.String })),
              }),
            }),
          }),
        ),
      )(sent.body);

      assert.strictEqual(wire.Content.Simple.Headers.length, 15);
      assert.strictEqual(wire.Content.Simple.Headers[0]?.Value, headers[0].value);
      assert.strictEqual(wire.Content.Simple.Headers[0]?.Name, "X-Workflow");
    }),
  );

  it.live(
    "enforces actual eight-million-byte UTF-8 JSON including attachments, without truncation",
    () =>
      Effect.gen(function* boundSesPayload() {
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
          attachments: [attachment, attachment, attachment],
          body: { html: "界".repeat(700_000), text: "界".repeat(500_000) },
        } as const;

        yield* Effect.gen(function* sendSesBudgetSeed() {
          return yield* (yield* Email).send(seed);
        }).pipe(Effect.provide(fixtureSesLayer(fixture)));
        const baseline = yield* Queue.take(fixture.received);
        const padding = 8_000_000 - Buffer.byteLength(baseline.body, "utf-8");
        assert.isAbove(padding, 0);

        const exact = {
          ...seed,
          body: { ...seed.body, html: `${seed.body.html}${"a".repeat(padding)}` },
        };

        yield* Effect.gen(function* sendExactSesBudget() {
          return yield* (yield* Email).send(exact);
        }).pipe(Effect.provide(fixtureSesLayer(fixture)));
        const sent = yield* Queue.take(fixture.received);
        assert.strictEqual(Buffer.byteLength(sent.body, "utf-8"), 8_000_000);
        yield* verifySesWireSignature(sent, options.region);

        const invalid = yield* Effect.gen(function* exceedSesBudget() {
          return yield* (yield* Email).send({
            ...exact,
            body: { ...exact.body, html: `${exact.body.html}a` },
          });
        }).pipe(Effect.provide(fixtureSesLayer(fixture)), Effect.result);

        assert(Result.isFailure(invalid) && invalid.failure instanceof EmailInvalidMessage);
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );

  it.live("rejects ordinary/direct keys and incompatible backup intent before primary HTTP", () =>
    Effect.gen(function* defendSesRoutesAndKeys() {
      const primary = yield* startEmailHttpFixture({
        body: JSON.stringify({ id: "primary" }),
        status: 200,
      });

      const backup = yield* startEmailHttpFixture({
        body: JSON.stringify(acknowledgement),
        status: 200,
      });

      const ordinary = yield* Effect.gen(function* keyedSes() {
        return yield* (yield* Email).send(message, { idempotencyKey: "private-key" });
      }).pipe(Effect.provide(fixtureSesLayer(backup)), Effect.result);

      assert(Result.isFailure(ordinary) && ordinary.failure instanceof EmailRejected);

      const direct = yield* Effect.gen(function* keyedDirectSes() {
        return yield* (yield* EmailSender).submit({
          idempotencyKey: EmailIdempotencyKeySchema.make("private-key"),
          message: yield* parseEmailMessage(message),
        });
      }).pipe(
        Effect.provide(
          sesSenderLayer(options).pipe(
            Layer.provide(
              emailFixtureClientLayer(backup.url, "https://email.us-east-1.amazonaws.com"),
            ),
          ),
        ),
        Effect.result,
      );

      assert(Result.isFailure(direct) && direct.failure instanceof EmailRejected);

      const routed = yield* Effect.gen(function* incompatibleSesBackup() {
        const email = yield* (yield* EmailRouter).select();

        return [
          yield* email.send(message, { idempotencyKey: "private-key" }).pipe(Effect.result),
          yield* email
            .send({ ...message, from: { address: "sender@example.test", name: "Café" } })
            .pipe(Effect.result),
        ] as const;
      }).pipe(
        Effect.provide(
          emailRouterLayer(
            [
              {
                layer: resendEmailLayer(
                  { apiKey: Redacted.make("fictional-primary") },
                  policy,
                ).pipe(
                  Layer.provide(emailFixtureClientLayer(primary.url, "https://api.resend.com")),
                ),
                name: "primary",
              },
              { layer: fixtureSesLayer(backup), name: "backup" },
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
    { field: "accessKeyId", value: "PRIVATEUNWRAPPEDKEY" },
    { field: "accessKeyId", value: Redacted.make("private-invalid") },
    { field: "secretAccessKey", value: Redacted.make("private\nsecret") },
    { field: "secretAccessKey", value: "private-unwrapped" },
    { field: "sessionToken", value: Redacted.make("private token") },
    { field: "sessionToken", value: "private-unwrapped" },
    { field: "region", value: "private/path" },
    { field: "region", value: "us-gov-west-1" },
    { field: "mailFlow", value: "AllowRewriting" },
    { field: "baseUrl", value: "https://private.test" },
    ...["accessKeyId", "secretAccessKey", "region", "mailFlow"].map((field) => ({
      field,
      value: undefined,
    })),
  ])(
    "requires explicit bounded Redacted credentials and reviewed regional choices (case %#)",
    ({ field, value }) =>
      Effect.gen(function* invalidSesConfiguration() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 200,
        });

        const configuration = { ...options };
        Reflect.set(configuration, field, value);

        const result = yield* Effect.service(Email).pipe(
          Effect.provide(
            sesEmailLayer(configuration).pipe(
              Layer.provide(
                emailFixtureClientLayer(fixture.url, "https://email.us-east-1.amazonaws.com"),
              ),
            ),
          ),
          Effect.result,
        );

        assert(Result.isFailure(result) && result.failure instanceof EmailConfigurationError);
        assert.notInclude(JSON.stringify(result.failure), "private");
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );

  it.live("owns acquired credentials/region/mail-flow despite later mutation", () =>
    Effect.gen(function* ownSesConfiguration() {
      const fixture = yield* startEmailHttpFixture({
        body: JSON.stringify(acknowledgement),
        status: 200,
      });

      const configuration: SesEmailOptions = { ...options };
      yield* Effect.gen(function* mutateSesConfiguration() {
        const email = yield* Email;
        Reflect.set(configuration, "accessKeyId", Redacted.make("PRIVATECHANGEDKEY1234"));
        Reflect.set(configuration, "secretAccessKey", Redacted.make("private-mutated-secret"));
        Reflect.set(configuration, "sessionToken", Redacted.make("private-mutated-token"));
        Reflect.set(configuration, "region", "eu-west-1");
        Reflect.set(configuration, "mailFlow", "AllowRewriting");
        yield* email.send(message);
      }).pipe(Effect.provide(fixtureSesLayer(fixture, configuration)));
      const sent = yield* Queue.take(fixture.received);
      assert.strictEqual(sent.sesSessionToken, "fictional/session+token==");
      yield* verifySesWireSignature(sent, "us-east-1");
    }),
  );

  it.live(
    "keeps signatures, credential identifiers, tokens and private refusal reasons out of NativeSpan diagnostics",
    () =>
      Effect.gen(function* sesDiagnosticPrivacy() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify({ MessageId: "private-handle", message: "private-provider-reason" }),
          sesErrorType: "AccessDeniedException",
          status: 403,
        });

        const trace = yield* startEmailTraceFixture();

        const result = yield* Effect.gen(function* sendPrivateSes() {
          return yield* (yield* Email).send(message);
        }).pipe(
          Effect.provide(fixtureSesLayer(fixture)),
          Effect.provideService(Tracer.Tracer, trace.tracer),
          Effect.result,
        );

        assert(Result.isFailure(result) && result.failure instanceof EmailDeliveryUnknown);
        const diagnostics = yield* trace.diagnostics;
        assert.include(diagnostics, "Ses.submit");

        for (const privateValue of [
          "AKIAFICTIONALEXAMPLE1",
          "fictional-secret-access-key",
          "fictional/session+token==",
          "private-provider-reason",
          "private-handle",
          message.to,
          message.body.text,
        ]) {
          assert.notInclude(diagnostics, privateValue);
          assert.notInclude(JSON.stringify(result.failure), privateValue);
        }
      }),
  );
});
