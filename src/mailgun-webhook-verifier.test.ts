import { webcrypto } from "node:crypto";
import { assert, describe, it } from "@effect/vitest";
import {
  Clock,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Redacted,
  Result,
  Schema,
  Tracer,
} from "effect";
import { TestClock } from "effect/testing";
import { startEmailTraceFixture } from "../test/email-tracing-fixture.js";
import { EmailConfigurationError } from "./email-configuration-error.js";
import {
  EmailWebhookVerificationError,
  MailgunWebhookSignatureSchema,
  MailgunWebhookVerifier,
  mailgunWebhookLayer,
} from "./mailgun-webhook-verifier.js";
import type { MailgunWebhookOptions, MailgunWebhookSignature } from "./mailgun-webhook-verifier.js";

const secret = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

const epochMillis = 1_791_849_600_000;

const token = "fictional-private-mailgun-token-012345678901234567";

const timestamp = String(epochMillis / 1000);

const configuration: MailgunWebhookOptions = {
  signatureField: "signature",
  signingSecrets: [Redacted.make(secret)],
};

const signedRequest = Effect.fnUntraced(function* signedMailgunRequest(
  input: { readonly timestamp: string | number; readonly token: string },
  options: { readonly keyBytes?: Uint8Array<ArrayBuffer>; readonly content?: string } = {},
) {
  const key = yield* Effect.promise(
    webcrypto.subtle.importKey.bind(
      webcrypto.subtle,
      "raw",
      options.keyBytes ?? new TextEncoder().encode(secret),
      { hash: "SHA-256", name: "HMAC" },
      false,
      ["sign"],
    ),
  );

  const bytes = new TextEncoder().encode(options.content ?? `${input.timestamp}${input.token}`);

  const signature = yield* Effect.promise(
    webcrypto.subtle.sign.bind(webcrypto.subtle, "HMAC", key, bytes),
  );

  return { ...input, signature: Buffer.from(signature).toString("hex") };
});

const verifyRequest = Effect.fnUntraced(function* verifyMailgunRequest(
  request: MailgunWebhookSignature,
) {
  return yield* (yield* MailgunWebhookVerifier).verifySignature(request);
});

const expectInvalidRequest = Effect.fnUntraced(function* expectInvalidMailgunSignature(
  request: MailgunWebhookSignature,
) {
  const result = yield* verifyRequest(request).pipe(
    Effect.provide(mailgunWebhookLayer(configuration)),
    Effect.result,
  );

  assert(Result.isFailure(result) && result.failure instanceof EmailWebhookVerificationError);
  assert.strictEqual(result.failure.reason, "invalid-request");
  assert.notInclude(JSON.stringify(result.failure), "private");
});

describe("Mailgun webhook signature verification", () => {
  it.effect.prop(
    "checks independently signed timestamp/token pairs with the literal UTF-8 key and rejects changed tokens",
    { suffix: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9]{20}$/u)) },
    ({ suffix }) =>
      Effect.gen(function* verifyGeneratedMailgunTokens() {
        yield* TestClock.setTime(epochMillis);
        const generatedToken = `${"!".repeat(30)}${suffix}`;
        const request = yield* signedRequest({ timestamp, token: generatedToken });
        const proof = yield* verifyRequest(request);
        assert.strictEqual(String(proof.timestamp), timestamp);
        assert.strictEqual(String(proof.token), generatedToken);

        const changed = yield* verifyRequest({
          ...request,
          token: `?${generatedToken.slice(1)}`,
        }).pipe(Effect.result);

        assert(
          Result.isFailure(changed) && changed.failure instanceof EmailWebhookVerificationError,
        );
        assert.strictEqual(changed.failure.reason, "invalid-signature");
      }).pipe(Effect.provide(mailgunWebhookLayer(configuration))),
  );

  it.effect(
    "accepts numeric seconds and uppercase hexadecimal without signing JSON spelling or separators",
    () =>
      Effect.gen(function* verifyMailgunEncodings() {
        yield* TestClock.setTime(epochMillis);
        const request = yield* signedRequest({ timestamp: epochMillis / 1000, token });

        const proof = yield* verifyRequest({
          ...request,
          signature: request.signature.toUpperCase(),
        });

        assert.strictEqual(String(proof.timestamp), timestamp);
        const stringForm = yield* verifyRequest({ ...request, timestamp });
        assert.deepStrictEqual(stringForm, proof);

        const wrongContent = yield* signedRequest(
          { timestamp, token },
          { content: `${timestamp}.${token}` },
        );

        const wrongKeyEncoding = yield* signedRequest(
          { timestamp, token },
          { keyBytes: Uint8Array.from(Buffer.from(secret, "hex")) },
        );

        for (const input of [
          wrongContent,
          wrongKeyEncoding,
          { ...request, timestamp: epochMillis / 1000 + 1 },
        ]) {
          const result = yield* verifyRequest(input).pipe(Effect.result);
          assert(
            Result.isFailure(result) && result.failure instanceof EmailWebhookVerificationError,
          );
          assert.strictEqual(result.failure.reason, "invalid-signature");
        }
      }).pipe(Effect.provide(mailgunWebhookLayer(configuration))),
  );

  it.effect.each([0, 9_999_999_999])(
    "verifies both bounded epoch-second endpoints in numeric and string representations (%s)",
    (seconds) =>
      Effect.gen(function* verifyMailgunTimestampEndpoints() {
        yield* TestClock.setTime(seconds * 1000);
        const request = yield* signedRequest({ timestamp: seconds, token });
        const numeric = yield* verifyRequest(request);
        const text = yield* verifyRequest({ ...request, timestamp: String(seconds) });
        assert.strictEqual(String(numeric.timestamp), String(seconds));
        assert.deepStrictEqual(text, numeric);
      }).pipe(Effect.provide(mailgunWebhookLayer(configuration))),
  );

  it.effect.each([16, 256])(
    "preserves the literal UTF-8 signing key at the supported length boundary %s",
    (length) =>
      Effect.gen(function* verifyMailgunKeyEndpoints() {
        yield* TestClock.setTime(epochMillis);
        const signingKey = "x".repeat(length);

        const request = yield* signedRequest(
          { timestamp, token },
          { keyBytes: new TextEncoder().encode(signingKey) },
        );

        const proof = yield* verifyRequest(request).pipe(
          Effect.provide(
            mailgunWebhookLayer({ ...configuration, signingSecrets: [Redacted.make(signingKey)] }),
          ),
        );

        assert.strictEqual(String(proof.token), token);
      }),
  );

  it.effect(
    "uses only the explicitly selected primary or parent field, never a successful alternate",
    () =>
      Effect.gen(function* selectMailgunSigningAuthority() {
        yield* TestClock.setTime(epochMillis);
        const request = yield* signedRequest({ timestamp, token });
        const wrong = "00".repeat(32);
        const envelope = { ...request, "parent-signature": wrong };
        yield* verifyRequest(envelope).pipe(Effect.provide(mailgunWebhookLayer(configuration)));

        const parentConfiguration = {
          ...configuration,
          signatureField: "parent-signature",
        } as const;

        const rejected = yield* verifyRequest(envelope).pipe(
          Effect.provide(mailgunWebhookLayer(parentConfiguration)),
          Effect.result,
        );

        assert(
          Result.isFailure(rejected) && rejected.failure instanceof EmailWebhookVerificationError,
        );
        assert.strictEqual(rejected.failure.reason, "invalid-signature");

        const proof = yield* verifyRequest({
          ...request,
          "parent-signature": request.signature,
          signature: wrong,
        }).pipe(Effect.provide(mailgunWebhookLayer(parentConfiguration)));

        assert.strictEqual(proof.signatureField, "parent-signature");

        const missing = yield* verifyRequest(request).pipe(
          Effect.provide(mailgunWebhookLayer(parentConfiguration)),
          Effect.result,
        );

        assert(
          Result.isFailure(missing) && missing.failure instanceof EmailWebhookVerificationError,
        );
        assert.strictEqual(missing.failure.reason, "invalid-request");
        yield* expectInvalidRequest({ ...request, "parent-signature": "private-malformed" });
      }),
  );

  it.effect(
    "refuses unsigned event context instead of silently dropping it or promoting it to signature proof",
    () =>
      Effect.gen(function* distinguishMailgunBodyIntegrity() {
        yield* TestClock.setTime(epochMillis);
        const signed = yield* signedRequest({ timestamp, token });

        const withBody = { ...signed, body: "private-event-body" };

        const withEvent = {
          ...signed,
          "event-data": { event: "failed", recipient: "private-altered@fictional.invalid" },
        };

        yield* expectInvalidRequest(withBody);
        yield* expectInvalidRequest(withEvent);
      }).pipe(Effect.provide(mailgunWebhookLayer(configuration))),
  );

  it.effect.each([-300_001, -300_000, -1, 0, 1, 300_000, 300_001])(
    "checks past and future signed seconds against the current runtime clock at offset %s",
    (offset) =>
      Effect.gen(function* enforceMailgunFreshness() {
        yield* TestClock.setTime(epochMillis + offset);
        const request = yield* signedRequest({ timestamp, token });
        const result = yield* verifyRequest(request).pipe(Effect.result);

        if (Math.abs(offset) <= 300_000) {
          assert(Result.isSuccess(result));
        } else {
          assert(
            Result.isFailure(result) && result.failure instanceof EmailWebhookVerificationError,
          );
          assert.strictEqual(result.failure.reason, "timestamp-outside-tolerance");
        }
      }).pipe(Effect.provide(mailgunWebhookLayer(configuration))),
  );

  it.effect.each([
    "",
    "00",
    "+1",
    " 1",
    "1 ",
    "1.0",
    "1e3",
    "10000000000",
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    10_000_000_000,
  ])(
    "refuses malformed, fractional or unsafe timestamp %s before treating it as signed evidence",
    (value) =>
      Effect.gen(function* refuseMailgunTimestamp() {
        yield* TestClock.setTime(epochMillis);
        const request = yield* signedRequest({ timestamp, token });
        yield* expectInvalidRequest({ ...request, timestamp: value });
      }),
  );

  it.effect.each([
    "",
    token.slice(1),
    `${token}x`,
    ` ${token.slice(1)}`,
    `\n${token.slice(1)}`,
    `${"界".repeat(49)}x`,
  ])("refuses malformed token %s without a signature exception or private diagnostic", (value) =>
    Effect.gen(function* refuseMailgunToken() {
      yield* TestClock.setTime(epochMillis);
      const request = yield* signedRequest({ timestamp, token });
      yield* expectInvalidRequest({ ...request, token: value });
    }),
  );

  it.effect.each([
    "",
    "00",
    "00".repeat(31),
    "00".repeat(33),
    "gg".repeat(32),
    ` ${"0".repeat(63)}`,
    `0x${"00".repeat(31)}`,
  ])("refuses malformed hexadecimal signature %s without truncation", (signature) =>
    Effect.gen(function* refuseMailgunSignatureEncoding() {
      yield* TestClock.setTime(epochMillis);
      const request = yield* signedRequest({ timestamp, token });
      yield* expectInvalidRequest({ ...request, signature });
    }),
  );

  it.effect(
    "reuses publicly decoded signature envelopes and leaves repeated tokens visible for durable application replay claims",
    () =>
      Effect.gen(function* verifyRepeatedMailgunSignature() {
        yield* TestClock.setTime(epochMillis);
        const request = yield* signedRequest({ timestamp, token });
        const parsed = yield* Schema.decodeEffect(MailgunWebhookSignatureSchema)(request);
        const first = yield* verifyRequest(parsed);
        const repeated = yield* verifyRequest(parsed);
        assert.deepStrictEqual(repeated, first);
        Reflect.set(first, "token", "private-mutated-token");
        request.token = "x".repeat(50);
        assert.strictEqual(String(first.token), token);
        const unsupported = { ...request, "private-control": "private-value" };
        yield* expectInvalidRequest(unsupported);
      }).pipe(Effect.provide(mailgunWebhookLayer(configuration))),
  );

  it.effect(
    "owns the supplied key rotation, field selection and restricting tolerance before calls",
    () =>
      Effect.gen(function* ownMailgunWebhookAuthority() {
        yield* TestClock.setTime(epochMillis);

        const options = {
          signatureField: "signature",
          signingSecrets: [Redacted.make(secret)],
          tolerance: Duration.seconds(1),
        } as const;

        const request = yield* signedRequest({ timestamp, token });
        yield* Effect.gen(function* useOwnedMailgunAuthority() {
          const verifier = yield* MailgunWebhookVerifier;
          Reflect.set(options.signingSecrets, "0", Redacted.make("fictional-wrong-rotation-key"));
          Reflect.set(options, "signatureField", "parent-signature");
          Reflect.set(options.tolerance, "value", { millis: 300_000 });
          Reflect.set(options, "tolerance", Duration.seconds(300));
          const proof = yield* verifier.verifySignature(request);
          assert.strictEqual(proof.signatureField, "signature");
          yield* TestClock.adjust(Duration.millis(1001));
          const result = yield* verifier.verifySignature(request).pipe(Effect.result);
          assert(
            Result.isFailure(result) && result.failure instanceof EmailWebhookVerificationError,
          );
          assert.strictEqual(result.failure.reason, "timestamp-outside-tolerance");
        }).pipe(Effect.provide(mailgunWebhookLayer(options)));
      }),
  );

  it.effect(
    "accepts an explicit four-key rotation and refuses missing, empty or oversized authority without exposing private configuration",
    () =>
      Effect.gen(function* boundMailgunSigningAuthority() {
        yield* TestClock.setTime(epochMillis);
        const request = yield* signedRequest({ timestamp, token });
        yield* verifyRequest(request).pipe(
          Effect.provide(
            mailgunWebhookLayer({
              ...configuration,
              signingSecrets: [
                Redacted.make("fictional-wrong-key-one"),
                Redacted.make("fictional-wrong-key-two"),
                Redacted.make("fictional-wrong-key-three"),
                Redacted.make(secret),
              ],
            }),
          ),
        );
        const options = { ...configuration };

        for (const signingSecrets of [
          [],
          Array.from({ length: 5 }, () => Redacted.make(secret)),
          ["private-unwrapped-key"],
        ]) {
          Reflect.set(options, "signingSecrets", signingSecrets);

          const result = yield* Effect.service(MailgunWebhookVerifier).pipe(
            Effect.provide(mailgunWebhookLayer(options)),
            Effect.result,
          );

          assert(Result.isFailure(result) && result.failure instanceof EmailConfigurationError);
          assert.notInclude(JSON.stringify(result.failure), "private-unwrapped-key");
          assert.notInclude(JSON.stringify(result.failure), secret);
        }

        const missingSelection = { ...configuration };
        Reflect.deleteProperty(missingSelection, "signatureField");

        for (const value of [undefined, "private-selected-field"]) {
          if (value !== undefined) {
            Reflect.set(missingSelection, "signatureField", value);
          }

          const result = yield* Effect.service(MailgunWebhookVerifier).pipe(
            Effect.provide(mailgunWebhookLayer(missingSelection)),
            Effect.result,
          );

          assert(Result.isFailure(result) && result.failure instanceof EmailConfigurationError);
          assert.strictEqual(result.failure.issues[0]?.path, "signatureField");
          assert.notInclude(JSON.stringify(result.failure), "private-selected-field");
        }
      }),
  );

  it.effect.each([
    "",
    "private-short",
    "s".repeat(15),
    "private key with spaces",
    `${"s".repeat(256)}x`,
    "private\nkey-0123456789",
  ])("rejects invalid signing credentials without retaining the rejected value (%s)", (value) =>
    Effect.gen(function* refuseMailgunKeyConfiguration() {
      const result = yield* Effect.service(MailgunWebhookVerifier).pipe(
        Effect.provide(
          mailgunWebhookLayer({ ...configuration, signingSecrets: [Redacted.make(value)] }),
        ),
        Effect.result,
      );

      assert(Result.isFailure(result) && result.failure instanceof EmailConfigurationError);
      assert.strictEqual(result.failure.issues[0]?.path.split(".")[0], "signingSecrets");
      assert.notInclude(JSON.stringify(result.failure), value || "private-short");
    }),
  );

  it.effect.each([Duration.zero, Duration.millis(-1), Duration.infinity, Duration.millis(300_001)])(
    "never disables or widens freshness through tolerance %s",
    (tolerance) =>
      Effect.gen(function* refuseMailgunTolerance() {
        const result = yield* Effect.service(MailgunWebhookVerifier).pipe(
          Effect.provide(mailgunWebhookLayer({ ...configuration, tolerance })),
          Effect.result,
        );

        assert(Result.isFailure(result) && result.failure instanceof EmailConfigurationError);
        assert.strictEqual(result.failure.issues[0]?.path, "tolerance");
      }),
  );

  it.effect(
    "keeps tokens, signatures, signing keys and original clock defects out of actual span exits while preserving interruption",
    () =>
      Effect.gen(function* preservePrivateMailgunExits() {
        yield* TestClock.setTime(epochMillis);
        const trace = yield* startEmailTraceFixture();
        const request = yield* signedRequest({ timestamp, token });
        const clock = yield* Clock.Clock;
        const ready = yield* Deferred.make<true>();

        const delegatedClock = {
          currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
          currentTimeNanos: clock.currentTimeNanos,
          currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
          monotonicTimeNanos: clock.monotonicTimeNanos,
          monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
          sleep: (duration: Duration.Duration) => clock.sleep(duration),
        };

        yield* Effect.gen(function* inspectMailgunOperationExits() {
          yield* verifyRequest(request);
          yield* verifyRequest({ ...request, signature: "00".repeat(32) }).pipe(Effect.result);

          const interrupted = yield* verifyRequest(request).pipe(
            Effect.provideService(Clock.Clock, {
              ...delegatedClock,
              currentTimeMillis: Deferred.succeed(ready, true).pipe(Effect.andThen(Effect.never)),
            }),
            Effect.forkScoped,
          );

          yield* Deferred.await(ready);
          yield* Fiber.interrupt(interrupted);
          assert(Exit.hasInterrupts(yield* Fiber.await(interrupted)));

          const defect = yield* verifyRequest(request).pipe(
            Effect.provideService(Clock.Clock, {
              ...delegatedClock,
              currentTimeMillis: Effect.die("private-mailgun-clock-defect"),
            }),
            Effect.exit,
          );

          assert(Exit.hasDies(defect));

          const invalidClock = yield* verifyRequest(request).pipe(
            Effect.provideService(Clock.Clock, {
              ...delegatedClock,
              currentTimeMillis: Effect.succeed(Number.NaN),
            }),
            Effect.result,
          );

          assert(
            Result.isFailure(invalidClock) &&
              invalidClock.failure instanceof EmailWebhookVerificationError,
          );
          assert.strictEqual(invalidClock.failure.reason, "timestamp-outside-tolerance");
        }).pipe(
          Effect.provide(mailgunWebhookLayer(configuration)),
          Effect.provideService(Tracer.Tracer, trace.tracer),
        );
        const diagnostics = yield* trace.diagnostics;
        assert.include(diagnostics, "MailgunWebhook.verifySignature");

        for (const value of [
          secret,
          token,
          timestamp,
          request.signature,
          "private-mailgun-clock-defect",
        ]) {
          assert.notInclude(diagnostics, value);
        }
      }),
  );
});
