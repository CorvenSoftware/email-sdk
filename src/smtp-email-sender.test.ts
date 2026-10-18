import { assert, describe, it } from "@effect/vitest";
import {
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Queue,
  Random,
  Redacted,
  Result,
  Schema,
} from "effect";
import { TestClock } from "effect/testing";
import { startSmtpFixture } from "../test/smtp-loopback-fixture.js";
import { startEmailTraceFixture } from "../test/email-tracing-fixture.js";
import { EmailConfigurationError } from "./email-configuration-error.js";
import { EmailDeliveryUnknown } from "./email-delivery-unknown.js";
import {
  EmailIdempotencyKeySchema,
  EmailReceiptSchema,
  parseEmailMessage,
} from "./email-message.js";
import type { EmailMessageInput } from "./email-message.js";
import { EmailRouter, emailRouterLayer } from "./email-routing.js";
import { EmailRejected } from "./email-rejected.js";
import { EmailSender } from "./email-sender.js";
import { Email, emailLayer } from "./email-service.js";
import { recordingSenderLayer } from "./recording-email-sender.js";
import {
  EmailSubmissionObservations,
  observedEmailSenderLayer,
} from "./email-submission-observations.js";
import { SmtpAuthenticationSchema, smtpEmailLayer, smtpSenderLayer } from "./smtp-email-sender.js";
import type { SmtpEmailOptions } from "./smtp-email-sender.js";

const message: EmailMessageInput = {
  body: { text: "private body\n.dot\n.\nMAIL FROM:<injected@fictional.invalid>" },
  from: "private-sender@fictional.invalid",
  subject: "private subject 📨".repeat(10),
  to: "private-recipient@fictional.invalid",
};

const oneAttempt = {
  deadline: Duration.seconds(10),
  initialDelay: Duration.millis(1),
  maxAttempts: 1,
};

const retryPolicy = { ...oneAttempt, maxAttempts: 2 };

const optionsFor = (
  fixture: { readonly port: number; readonly certificate: string },
  security: SmtpEmailOptions["security"],
): SmtpEmailOptions => ({
  authentication: SmtpAuthenticationSchema.cases.None.make({}),
  certificateAuthority: fixture.certificate,
  helloName: "client.fictional.invalid",
  host: "127.0.0.1",
  mailFlow: "ProviderUnmodified",
  port: fixture.port,
  security,
  serverName: "localhost",
});

const submitMessage = (
  options: SmtpEmailOptions,
  input: EmailMessageInput = message,
  policy = oneAttempt,
) =>
  Email.pipe(
    Effect.flatMap((email) => email.send(input)),
    Effect.provide(smtpEmailLayer(options, policy)),
  );

const decodeHeader = (wire: string, name: string) => {
  const headers = wire.split("\r\n\r\n")[0] ?? "";
  const unfolded = headers.replaceAll(/\r\n[ \t]+/gu, " ");
  const line = unfolded.split("\r\n").find((field) => field.startsWith(`${name}: `)) ?? "";

  return line
    .slice(name.length + 2)
    .replaceAll(/\?= +=\?/gu, "?==?")
    .replaceAll(
      /[=]\?UTF-8\?B\?(?<encoded>[A-Za-z0-9+/=]+)\?=/gu,
      (_whole: string, encoded: string) => Buffer.from(encoded, "base64").toString("utf-8"),
    );
};

describe("SMTP submission through explicit TLS", () => {
  it.effect.each(["ImplicitTls", "StartTls"] as const)(
    "submits literal UTF-8 over %s without claiming queue IDs or delivery",
    (security) =>
      Effect.gen(function* verifySmtpUtf8() {
        const fixture = yield* startSmtpFixture({ fragments: true, security });
        const result = yield* submitMessage(optionsFor(fixture, security));
        assert(EmailReceiptSchema.guards.Accepted(result));
        assert.isUndefined(result.messageId);
        const wire = yield* Queue.take(fixture.data);
        assert.strictEqual(decodeHeader(wire, "Subject"), message.subject);

        for (const line of wire.split("\r\n").filter((field) => field.includes("=?UTF-8?B?"))) {
          assert.isAtMost(line.length, 76);
        }

        assert.include(wire, "From: private-sender@fictional.invalid\r\n");
        assert.include(wire, "To: private-recipient@fictional.invalid\r\n");
        assert.strictEqual(
          Buffer.from(wire.split("\r\n\r\n")[1] ?? "", "base64").toString("utf-8"),
          message.body.text?.replaceAll("\n", "\r\n"),
        );
        yield* Queue.take(fixture.closed);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "preserves groups, BCC privacy, repeated headers, alternatives and binary/CID MIME",
    () =>
      Effect.gen(function* verifySmtpMime() {
        const fixture = yield* startSmtpFixture({ security: "ImplicitTls" });

        const rich = {
          ...message,
          attachments: [
            {
              contentBase64: "AAH/",
              contentType: "application/octet-stream",
              filename: "report.bin",
            },
            {
              contentBase64: "AQID",
              contentId: "logo@fictional",
              contentType: "image/png",
              filename: "logo.png",
            },
          ],
          bcc: "hidden@fictional.invalid",
          body: {
            html: '<p>literal &amp; <img src="cid:logo@fictional"></p>',
            text: "text alternative",
          },
          cc: { address: "copy@fictional.invalid", name: "コピー" },
          from: { address: "sender@fictional.invalid", name: "Sender 📨" },
          headers: [
            { name: "X-Custom", value: "first" },
            { name: "X-Custom", value: "second" },
          ],
          replyTo: ["reply@fictional.invalid"],
        } satisfies EmailMessageInput;

        yield* submitMessage(optionsFor(fixture, "ImplicitTls"), rich);
        const wire = yield* Queue.take(fixture.data);
        assert.strictEqual(decodeHeader(wire, "From"), "Sender 📨 <sender@fictional.invalid>");
        assert.strictEqual(decodeHeader(wire, "Cc"), "コピー <copy@fictional.invalid>");
        assert.notInclude(wire, "Bcc:");
        assert.notInclude(wire, "hidden@fictional.invalid");
        assert.include(
          yield* Queue.takeAll(fixture.commands),
          "RCPT TO:<hidden@fictional.invalid>",
        );
        assert.include(wire, "X-Custom: first\r\nX-Custom: second\r\n");

        for (const subtype of ["mixed", "related", "alternative"]) {
          assert.include(wire, `multipart/${subtype}`);
        }

        assert.match(wire, /multipart\/related;[^\r\n]*type="multipart\/alternative"/u);
        assert.include(wire, "Content-ID: <logo@fictional>");
        assert.include(wire, 'filename="report.bin"');
        assert.include(wire, "\r\n\r\nAAH/\r\n");
        assert.include(wire, "\r\n\r\nAQID\r\n");

        for (const line of wire.split("\r\n")) {
          assert.isAtMost(line.length, 998);
        }
      }).pipe(Effect.scoped),
  );

  it.effect.each(["Plain", "Login"] as const)(
    "uses selected %s authentication only after verified STARTTLS",
    (method) =>
      Effect.gen(function* verifySmtpAuthentication() {
        const fixture = yield* startSmtpFixture({ security: "StartTls" });

        const options = {
          ...optionsFor(fixture, "StartTls"),
          authentication: SmtpAuthenticationSchema.cases[method].make({
            password: Redacted.make("fictional-password"),
            username: Redacted.make("fictional-user"),
          }),
        };

        yield* submitMessage(options);
        const commands = yield* Queue.takeAll(fixture.commands);
        assert.deepStrictEqual(commands.slice(0, 4), [
          "EHLO client.fictional.invalid",
          "STARTTLS",
          "EHLO client.fictional.invalid",
          `AUTH ${method.toUpperCase()}`,
        ]);
        assert.strictEqual(
          Buffer.from(commands[4] ?? "", "base64").toString("utf-8"),
          method === "Plain" ? "\0fictional-user\0fictional-password" : "fictional-user",
        );
      }).pipe(Effect.scoped),
  );

  it.effect.each([
    { hello: "250-localhost\r\n250 AUTH PLAIN\r\n", security: "StartTls" },
    { secureHello: "250-localhost\r\n250 SIZE 99999\r\n", security: "StartTls" },
    { security: "StartTls", startTlsReply: "454 unavailable\r\n" },
  ] as const)("never downgrades TLS or reuses pre-TLS authentication advertisements", (behavior) =>
    Effect.gen(function* verifySmtpNoDowngrade() {
      const fixture = yield* startSmtpFixture(behavior);

      const options = {
        ...optionsFor(fixture, behavior.security),
        authentication: SmtpAuthenticationSchema.cases.Plain.make({
          password: Redacted.make("fictional-password"),
          username: Redacted.make("fictional-user"),
        }),
      };

      const result = yield* Effect.result(submitMessage(options));
      assert(Result.isFailure(result));
      assert.strictEqual(result.failure._tag, "EmailRejected");
      const commands = yield* Queue.takeAll(fixture.commands);
      assert.isFalse(
        commands.some((command) => command.startsWith("AUTH ") || command.startsWith("MAIL ")),
      );
    }).pipe(Effect.scoped),
  );

  it.effect.each(["wrong.fictional.invalid", "UntrustedRoot"])(
    "rejects %s certificates before SMTP commands",
    (mode) =>
      Effect.gen(function* verifySmtpCertificates() {
        const fixture = yield* startSmtpFixture({ security: "ImplicitTls" });

        const config = {
          ...optionsFor(fixture, "ImplicitTls"),
          serverName: mode === "UntrustedRoot" ? "localhost" : mode,
        };

        if (mode === "UntrustedRoot") {
          Reflect.deleteProperty(config, "certificateAuthority");
        }

        const result = yield* Effect.result(submitMessage(config));
        assert(Result.isFailure(result));
        assert(result.failure instanceof EmailDeliveryUnknown);
        assert.strictEqual(yield* Queue.size(fixture.commands), 0);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "owns configuration and rejects unsupported intent and keys before opening a socket",
    () =>
      Effect.gen(function* verifySmtpPreflight() {
        const fixture = yield* startSmtpFixture({ security: "ImplicitTls" });
        const options = optionsFor(fixture, "ImplicitTls");

        const app = Effect.gen(function* exerciseSmtpPreflight() {
          const email = yield* Email;
          Reflect.set(options, "helloName", "mutated.fictional.invalid");

          const invalidMessages = [
            { ...message, metadata: { private: "value" } },
            { ...message, sendAt: "2030-01-01T00:00:00.000Z" },
            { ...message, cc: "PRIVATE-RECIPIENT@fictional.invalid" },
            { ...message, body: { text: "\uD800" } },
            {
              ...message,
              attachments: [
                { contentBase64: "AQID", contentType: "message/rfc822", filename: "mail.eml" },
              ],
            },
            {
              ...message,
              attachments: [
                {
                  contentBase64: "AQID",
                  contentId: "unqualified",
                  contentType: "image/png",
                  filename: "logo.png",
                },
              ],
            },
            { ...message, headers: [{ name: "X-Custom", value: "non-ascii 📨" }] },
          ] satisfies EmailMessageInput[];

          for (const invalid of invalidMessages) {
            const result = yield* Effect.result(email.send(invalid));
            assert(Result.isFailure(result));
            assert.strictEqual(result.failure._tag, "EmailInvalidMessage");
          }

          assert(
            Result.isFailure(
              yield* Effect.result(email.send(message, { idempotencyKey: "fictional-key" })),
            ),
          );
          assert.strictEqual(yield* Queue.size(fixture.connected), 0);
          yield* email.send(message);
          assert.strictEqual(yield* Queue.take(fixture.commands), "EHLO client.fictional.invalid");
        });

        yield* app.pipe(Effect.provide(smtpEmailLayer(options, oneAttempt)));
      }).pipe(Effect.scoped),
  );

  it.effect.each([0, 65_536])(
    "fails invalid port %s during acquisition with safe diagnostics",
    (port) =>
      Effect.gen(function* verifySmtpConfiguration() {
        const fixture = yield* startSmtpFixture({ security: "ImplicitTls" });

        const result = yield* Effect.result(
          EmailSender.pipe(
            Effect.provide(smtpSenderLayer({ ...optionsFor(fixture, "ImplicitTls"), port })),
          ),
        );

        assert(Result.isFailure(result));
        assert(result.failure instanceof EmailConfigurationError);
        assert.strictEqual(yield* Queue.size(fixture.connected), 0);
      }).pipe(Effect.scoped),
  );

  it.effect.each([
    "250-first\r\n251 final\r\n",
    `250 ${"x".repeat(511)}\r\n`,
    `${"250-localhost\r\n".repeat(33)}250 end\r\n`,
    "350 unexpected\r\n",
  ])("refuses malformed or unexpected replies without submitting DATA", (secureHello) =>
    Effect.gen(function* verifySmtpReplyBounds() {
      const fixture = yield* startSmtpFixture({ secureHello, security: "ImplicitTls" });
      const result = yield* Effect.result(submitMessage(optionsFor(fixture, "ImplicitTls")));
      assert(Result.isFailure(result));
      assert(result.failure instanceof EmailDeliveryUnknown);
      assert.strictEqual(yield* Queue.size(fixture.data), 0);
    }).pipe(Effect.scoped),
  );

  it.effect("reports known partial rejection without inventing suppression, IDs or fallback", () =>
    Effect.gen(function* verifySmtpPartialRejection() {
      const fixture = yield* startSmtpFixture({
        recipientCodes: [250, 550, 251],
        security: "ImplicitTls",
      });

      const primary = smtpEmailLayer(optionsFor(fixture, "ImplicitTls"), oneAttempt);
      const backup = emailLayer(oneAttempt).pipe(Layer.provide(recordingSenderLayer));

      const app = Effect.gen(function* routeSmtpPartialReceipt() {
        const receipt = yield* (yield* Email).send({
          ...message,
          bcc: "accepted-hidden@fictional.invalid",
          cc: "rejected@fictional.invalid",
        });

        assert(EmailReceiptSchema.guards.PartiallyRejected(receipt));
        assert.deepStrictEqual(receipt.accepted.map(String), [
          "private-recipient@fictional.invalid",
          "accepted-hidden@fictional.invalid",
        ]);
        assert.deepStrictEqual(receipt.rejected.map(String), ["rejected@fictional.invalid"]);
        assert(Object.isFrozen(receipt.accepted));
        assert(Object.isFrozen(receipt.rejected));
        assert.strictEqual(yield* Queue.size(fixture.data), 1);
      });

      yield* app.pipe(
        Effect.provide(
          emailRouterLayer(
            [
              { layer: primary, name: "smtp" },
              { layer: backup, name: "backup" },
            ],
            { fallbacks: ["backup"], primary: "smtp" },
          ),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("returns terminal complete recipient rejection without transmitting a body", () =>
    Effect.gen(function* verifySmtpAllRejected() {
      const fixture = yield* startSmtpFixture({
        recipientCodes: [550, 450],
        security: "ImplicitTls",
      });

      const receipt = yield* submitMessage(
        optionsFor(fixture, "ImplicitTls"),
        { ...message, cc: "copy@fictional.invalid" },
        retryPolicy,
      );

      assert(EmailReceiptSchema.guards.RecipientsRejected(receipt));
      assert.deepStrictEqual(receipt.rejected.map(String), [
        "private-recipient@fictional.invalid",
        "copy@fictional.invalid",
      ]);
      assert.strictEqual(yield* Queue.size(fixture.data), 0);
      assert.strictEqual(yield* Queue.size(fixture.connected), 1);
    }).pipe(Effect.scoped),
  );

  it.live(
    "retries only explicit non-acceptance, retaining SMTP numeric evidence without HTTP labels",
    () =>
      Effect.gen(function* verifySmtpRefusalRetry() {
        const fixture = yield* startSmtpFixture({
          finalReply: "451 private deferred\r\n",
          secureHello: "250-localhost\r\n250 SIZE 9999999999\r\n",
          security: "ImplicitTls",
        });

        const result = yield* Effect.result(
          submitMessage(optionsFor(fixture, "ImplicitTls"), message, retryPolicy),
        );

        assert(Result.isFailure(result));
        assert.strictEqual(result.failure._tag, "EmailRejected");
        assert.include(result.failure.message, "provider code 451");
        assert.notInclude(result.failure.message, "HTTP");
        assert.notInclude(result.failure.message, "private deferred");
        assert.strictEqual(yield* Queue.size(fixture.data), 2);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "never retries or falls back after losing the final reply; observations and spans stay minimal",
    () =>
      Effect.gen(function* verifySmtpUncertainty() {
        const fixture = yield* startSmtpFixture({
          dataAction: "Drop",
          secureHello: "250-localhost\r\n250 SIZE 9999999999\r\n",
          security: "ImplicitTls",
        });

        const trace = yield* startEmailTraceFixture();

        const senders = observedEmailSenderLayer(
          smtpSenderLayer(optionsFor(fixture, "ImplicitTls")),
        );

        const smtp = emailLayer(retryPolicy).pipe(Layer.provideMerge(senders));
        const backup = emailLayer(oneAttempt).pipe(Layer.provide(recordingSenderLayer));

        const app = Effect.gen(function* observeSmtpUnknown() {
          const result = yield* Effect.result((yield* Email).send(message));
          assert(Result.isFailure(result));
          assert(result.failure instanceof EmailDeliveryUnknown);
          const snapshot = yield* (yield* EmailSubmissionObservations).snapshot;
          assert.deepStrictEqual(
            snapshot.observations.map((observation) => observation._tag),
            ["Unknown"],
          );
          assert.strictEqual(yield* Queue.size(fixture.data), 1);
        });

        yield* app.pipe(Effect.provide(smtp), Effect.withTracer(trace.tracer));
        const diagnostics = yield* trace.diagnostics;

        for (const value of [
          "private body",
          "private subject",
          "private-recipient",
          "private-queue-handle",
        ]) {
          assert.notInclude(diagnostics, value);
        }

        const routed = yield* Effect.result(
          Email.pipe(
            Effect.flatMap((email) => email.send(message)),
            Effect.provide(
              emailRouterLayer(
                [
                  { layer: smtp, name: "smtp" },
                  { layer: backup, name: "backup" },
                ],
                { fallbacks: ["backup"], primary: "smtp" },
              ),
            ),
          ),
        );

        assert(Result.isFailure(routed));
        assert(routed.failure instanceof EmailDeliveryUnknown);
      }).pipe(Effect.scoped),
  );

  it.effect.each(["Interrupt", "Deadline", "AttemptTimeout"] as const)(
    "%s closes an in-flight DATA socket without manufacturing acceptance",
    (mode) =>
      Effect.gen(function* verifySmtpCancellation() {
        const fixture = yield* startSmtpFixture({ dataAction: "Hold", security: "ImplicitTls" });

        const options = {
          ...optionsFor(fixture, "ImplicitTls"),
          attemptTimeout: Duration.seconds(mode === "AttemptTimeout" ? 1 : 30),
        };

        const fiber = yield* submitMessage(options).pipe(Effect.forkScoped);

        yield* Queue.take(fixture.data);

        if (mode === "Interrupt") {
          yield* Fiber.interrupt(fiber);
          assert(Exit.hasInterrupts(yield* Fiber.await(fiber)));
        } else {
          yield* TestClock.adjust(mode === "AttemptTimeout" ? "1 second" : "10 seconds");
          const exit = yield* Fiber.await(fiber);
          assert(Exit.isFailure(exit));
          assert.isFalse(Exit.hasInterrupts(exit));
        }

        assert.strictEqual(yield* Queue.take(fixture.closed), true);
      }).pipe(Effect.scoped),
  );

  it.effect.prop(
    "round trips generated Unicode across header and MIME folding boundaries",
    {
      characters: Schema.NonEmptyArray(Schema.Literals(["é", "🦉", "漢", " ", ".", "A"])).check(
        Schema.isMaxLength(100),
      ),
    },
    ({ characters }) =>
      Effect.gen(function* verifyGeneratedSmtpUnicode() {
        const fixture = yield* startSmtpFixture({
          secureHello: "250-localhost\r\n250 SIZE 9999999999\r\n",
          security: "ImplicitTls",
        });

        const text = characters.join("");
        yield* submitMessage(optionsFor(fixture, "ImplicitTls"), {
          ...message,
          body: { text },
          subject: text,
        });
        const wire = yield* Queue.take(fixture.data);
        assert.strictEqual(decodeHeader(wire, "Subject"), text);
        const commands = yield* Queue.takeAll(fixture.commands);
        assert.include(
          commands,
          `MAIL FROM:<private-sender@fictional.invalid> SIZE=${Buffer.byteLength(wire, "utf-8")}`,
        );
        assert.strictEqual(
          Buffer.from(wire.split("\r\n\r\n")[1] ?? "", "base64").toString("utf-8"),
          text,
        );
      }).pipe(Effect.scoped),
    { arbitrary: { runs: 12 } },
  );

  it.effect.each(["SIZE", "sIzE 0", "SIZE 00000099999999", `SIZE ${"9".repeat(100)}`])(
    "declares the exact MIME octets for %s without counting the DATA terminator",
    (advertisement) =>
      Effect.gen(function* declareSmtpMessageSize() {
        const fixture = yield* startSmtpFixture({
          secureHello: `250-localhost\r\n250 ${advertisement}\r\n`,
          security: "ImplicitTls",
        });

        const receipt = yield* submitMessage(optionsFor(fixture, "ImplicitTls"), {
          ...message,
          attachments: [
            {
              contentBase64: "AAH/",
              contentType: "application/octet-stream",
              filename: "fictional.bin",
            },
          ],
          bcc: "hidden@fictional.invalid",
          body: { html: "<p>Fictional café 🦉</p>", text: "Fictional café\n🦉" },
          headers: [
            { name: "X-Fictional", value: "first" },
            { name: "X-Fictional", value: "second" },
          ],
        });

        assert(EmailReceiptSchema.guards.Accepted(receipt));
        const wire = yield* Queue.take(fixture.data);
        assert.notInclude(wire, "hidden@fictional.invalid");
        assert.include(wire, "multipart/mixed");
        const commands = yield* Queue.takeAll(fixture.commands);
        assert.include(
          commands,
          `MAIL FROM:<private-sender@fictional.invalid> SIZE=${Buffer.byteLength(wire, "utf-8")}`,
        );
        assert.include(commands, "RCPT TO:<hidden@fictional.invalid>");
      }).pipe(Effect.scoped),
  );

  it.effect.each([452, 552])(
    "retains extended MAIL refusal %s without treating SIZE as acceptance",
    (code) =>
      Effect.gen(function* preserveSmtpSizeCommandRefusal() {
        const fixture = yield* startSmtpFixture({
          mailReply: `${code} private-size-refusal\r\n`,
          secureHello: "250-localhost\r\n250 SIZE 9999999999\r\n",
          security: "ImplicitTls",
        });

        const failure = yield* Effect.flip(submitMessage(optionsFor(fixture, "ImplicitTls")));
        assert(failure instanceof EmailRejected);
        assert.strictEqual(failure.providerCode, code);
        assert.strictEqual(failure.reason, code === 452 ? "temporarily-unavailable" : "rejected");
        assert.isUndefined(failure.status);
        assert.notInclude(JSON.stringify(failure), "private-size-refusal");
        assert.strictEqual(yield* Queue.size(fixture.data), 0);
        const commands = yield* Queue.takeAll(fixture.commands);
        assert(commands.some((command) => /^MAIL FROM:<[^>]+> SIZE=[0-9]+$/u.test(command)));
        assert.isFalse(commands.some((command) => command.startsWith("RCPT ")));
      }).pipe(Effect.scoped),
  );

  it.effect("accepts an exact size limit and refuses one octet less before MAIL or DATA", () =>
    Effect.gen(function* enforceExactSmtpSizeLimit() {
      const baseline = yield* startSmtpFixture({
        secureHello: "250-localhost\r\n250 SIZE\r\n",
        security: "ImplicitTls",
      });

      yield* submitMessage(optionsFor(baseline, "ImplicitTls")).pipe(
        Random.withSeed("smtp-size-boundary"),
      );
      const octets = Buffer.byteLength(yield* Queue.take(baseline.data), "utf-8");

      const exact = yield* startSmtpFixture({
        secureHello: `250-localhost\r\n250 SIZE ${octets}\r\n`,
        security: "ImplicitTls",
      });

      const receipt = yield* submitMessage(optionsFor(exact, "ImplicitTls")).pipe(
        Random.withSeed("smtp-size-boundary"),
      );

      assert(EmailReceiptSchema.guards.Accepted(receipt));
      assert.strictEqual(Buffer.byteLength(yield* Queue.take(exact.data), "utf-8"), octets);

      const small = yield* startSmtpFixture({
        secureHello: `250-localhost\r\n250 SIZE ${octets - 1}\r\n`,
        security: "ImplicitTls",
      });

      const failure = yield* Effect.flip(
        submitMessage(optionsFor(small, "ImplicitTls"), message, retryPolicy).pipe(
          Random.withSeed("smtp-size-boundary"),
        ),
      );

      assert(failure instanceof EmailRejected);
      assert.strictEqual(failure.reason, "rejected");
      assert.isUndefined(failure.providerCode);
      assert.strictEqual(yield* Queue.size(small.connected), 1);
      assert.deepStrictEqual(yield* Queue.takeAll(small.commands), [
        "EHLO client.fictional.invalid",
      ]);
      assert.strictEqual(yield* Queue.size(small.data), 0);
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    { helloSize: "SIZE 1", outcome: "Sized", secureSize: "SIZE 9999999999" },
    { helloSize: "SIZE 9999999999", outcome: "Rejected", secureSize: "SIZE 1" },
    { helloSize: "SIZE private-pre-TLS", outcome: "Bare", secureSize: "AUTH PLAIN LOGIN" },
  ] as const)(
    "uses only the verified post-STARTTLS size advertisement: $outcome",
    ({ helloSize, secureSize, outcome }) =>
      Effect.gen(function* discardPreTlsSmtpSize() {
        const fixture = yield* startSmtpFixture({
          hello: `250-localhost\r\n250-STARTTLS\r\n250 ${helloSize}\r\n`,
          secureHello: `250-localhost\r\n250 ${secureSize}\r\n`,
          security: "StartTls",
        });

        const result = yield* Effect.result(submitMessage(optionsFor(fixture, "StartTls")));
        const commands = yield* Queue.takeAll(fixture.commands);

        if (outcome === "Rejected") {
          assert(Result.isFailure(result));
          assert(result.failure instanceof EmailRejected);
          assert.isFalse(commands.some((command) => command.startsWith("MAIL ")));
          assert.strictEqual(yield* Queue.size(fixture.data), 0);
        } else {
          assert(Result.isSuccess(result));
          assert(EmailReceiptSchema.guards.Accepted(result.success));
          const wire = yield* Queue.take(fixture.data);
          assert.include(
            commands,
            `MAIL FROM:<private-sender@fictional.invalid>${outcome === "Sized" ? ` SIZE=${Buffer.byteLength(wire, "utf-8")}` : ""}`,
          );
        }
      }).pipe(Effect.scoped),
  );

  it.effect.each([
    "SIZE -1",
    "SIZE 1.5",
    "SIZE=99999",
    "SIZE 1 2",
    "SIZE\t99999",
    "SIZE private-smtp-size-proof",
    "SIZE 99999\r\n250-SIZE 99999",
  ])(
    "refuses malformed or duplicate size evidence without retry or private diagnostics: %s",
    (advertisement) =>
      Effect.gen(function* refuseAmbiguousSmtpSize() {
        const fixture = yield* startSmtpFixture({
          secureHello: `250-localhost\r\n250-${advertisement}\r\n250 AUTH PLAIN LOGIN\r\n`,
          security: "ImplicitTls",
        });

        const trace = yield* startEmailTraceFixture();

        const failure = yield* Effect.flip(
          submitMessage(optionsFor(fixture, "ImplicitTls"), message, retryPolicy).pipe(
            Effect.withTracer(trace.tracer),
          ),
        );

        assert(failure instanceof EmailDeliveryUnknown);
        assert.strictEqual(failure.reason, "invalid-response");
        assert.strictEqual(yield* Queue.size(fixture.connected), 1);
        assert.strictEqual(yield* Queue.size(fixture.data), 0);
        assert.deepStrictEqual(yield* Queue.takeAll(fixture.commands), [
          "EHLO client.fictional.invalid",
        ]);
        assert.notInclude(JSON.stringify(failure), advertisement);
        assert.notInclude(yield* trace.diagnostics, "private-smtp-size-proof");
      }).pipe(Effect.scoped),
  );

  it.effect(
    "does not infer SIZE support from a similarly named extension or the EHLO greeting",
    () =>
      Effect.gen(function* requireActualSmtpSizeExtension() {
        const fixture = yield* startSmtpFixture({
          secureHello: "250-SIZE 1\r\n250 SIZE-LIMIT 1\r\n",
          security: "ImplicitTls",
        });

        const receipt = yield* submitMessage(optionsFor(fixture, "ImplicitTls"));
        assert(EmailReceiptSchema.guards.Accepted(receipt));
        assert.include(
          yield* Queue.takeAll(fixture.commands),
          "MAIL FROM:<private-sender@fictional.invalid>",
        );
      }).pipe(Effect.scoped),
  );

  it.effect(
    "keeps preflight network-free and permits unchanged-intent fallback only after local size refusal",
    () =>
      Effect.gen(function* routeSmtpSizeRefusal() {
        const primary = yield* startSmtpFixture({
          secureHello: "250-localhost\r\n250 SIZE 1\r\n",
          security: "ImplicitTls",
        });

        const backup = yield* startSmtpFixture({ security: "ImplicitTls" });

        const app = Effect.gen(function* submitRoutedSmtpSizeRefusal() {
          const email = yield* (yield* EmailRouter).select();
          yield* email.validate(message);
          assert.strictEqual(yield* Queue.size(primary.connected), 0);
          assert.strictEqual(yield* Queue.size(backup.connected), 0);
          const receipt = yield* email.send(message);
          assert(EmailReceiptSchema.guards.Accepted(receipt));
          assert.strictEqual(receipt.route, "backup");
          assert.strictEqual(yield* Queue.size(primary.data), 0);
          const wire = yield* Queue.take(backup.data);
          assert.strictEqual(decodeHeader(wire, "Subject"), message.subject);
          assert.strictEqual(
            Buffer.from(wire.split("\r\n\r\n")[1] ?? "", "base64").toString("utf-8"),
            message.body.text?.replaceAll("\n", "\r\n"),
          );
        });

        yield* app.pipe(
          Effect.provide(
            emailRouterLayer(
              [
                {
                  layer: smtpEmailLayer(optionsFor(primary, "ImplicitTls"), retryPolicy),
                  name: "primary",
                },
                {
                  layer: smtpEmailLayer(optionsFor(backup, "ImplicitTls"), oneAttempt),
                  name: "backup",
                },
              ],
              { fallbacks: ["backup"], primary: "primary" },
            ),
          ),
        );
      }).pipe(Effect.scoped),
  );

  it.effect("defends unsupported keys for direct sender callers before transport", () =>
    Effect.gen(function* verifyDirectSmtpKey() {
      const fixture = yield* startSmtpFixture({ security: "ImplicitTls" });
      const parsed = yield* parseEmailMessage(message);

      const app = Effect.gen(function* submitDirectSmtpKey() {
        const sender = yield* EmailSender;

        const result = yield* Effect.result(
          sender.submit({
            idempotencyKey: EmailIdempotencyKeySchema.make("fictional-key"),
            message: parsed,
          }),
        );

        assert(Result.isFailure(result));
        assert.strictEqual(yield* Queue.size(fixture.connected), 0);
      });

      yield* app.pipe(Effect.provide(smtpSenderLayer(optionsFor(fixture, "ImplicitTls"))));
    }).pipe(Effect.scoped),
  );
});
