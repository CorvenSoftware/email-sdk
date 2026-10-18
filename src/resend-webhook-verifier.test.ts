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
import { EmailConfigurationError } from "./index.js";
import {
  EmailWebhookVerificationError,
  ResendWebhookRequestSchema,
  ResendWebhookVerifier,
  resendWebhookLayer,
} from "./resend-webhook-verifier.js";
import type { ResendWebhookRequest } from "./resend-webhook-verifier.js";

const epochMillis = 1_731_705_121_000;

const keyBytes = new TextEncoder().encode("fictional-independent-signing-key");

const secret = `whsec_${Buffer.from(keyBytes).toString("base64")}`;

const configuration = { signingSecrets: [Redacted.make(secret)] } as const;

const signedRequest = Effect.fnUntraced(function* independentlySignResendRequest(
  body: string,
  metadata: { readonly timestamp?: string; readonly id?: string } = {},
) {
  const timestamp = metadata.timestamp ?? String(epochMillis / 1000);
  const id = metadata.id ?? "private-webhook-id";

  const key = yield* Effect.promise(
    webcrypto.subtle.importKey.bind(
      webcrypto.subtle,
      "raw",
      keyBytes,
      { hash: "SHA-256", name: "HMAC" },
      false,
      ["sign"],
    ),
  );

  const bytes = new TextEncoder().encode(`${id}.${timestamp}.${body}`);

  const signature = yield* Effect.promise(
    webcrypto.subtle.sign.bind(webcrypto.subtle, "HMAC", key, bytes),
  );

  return {
    body,
    headers: [
      { name: "svix-id", value: id },
      { name: "svix-timestamp", value: timestamp },
      { name: "svix-signature", value: `v1,${Buffer.from(signature).toString("base64")}` },
    ],
  };
});

const verifyRequest = (request: ResendWebhookRequest) =>
  Effect.gen(function* verifyPublicResendRequest() {
    return yield* (yield* ResendWebhookVerifier).verify(request);
  });

const signatureHeader = (request: ResendWebhookRequest): string =>
  request.headers.find((header) => header.name.toLowerCase() === "svix-signature")?.value ?? "";

const replaceHeader = (
  request: ResendWebhookRequest,
  name: string,
  value: string,
): ResendWebhookRequest => ({
  ...request,
  headers: request.headers.map((header) => (header.name === name ? { ...header, value } : header)),
});

describe("Resend authenticated raw webhook payloads", () => {
  it.effect(
    "matches the independently published Svix vector without executing upstream examples",
    () =>
      Effect.gen(function* verifyPublishedSvixVector() {
        yield* TestClock.setTime(epochMillis);
        const body = '{"event_type":"ping","data":{"success":true}}';

        const verified = yield* verifyRequest({
          body,
          headers: [
            { name: "svix-id", value: "msg_loFOjxBNrRLzqYUf" },
            { name: "svix-timestamp", value: "1731705121" },
            { name: "svix-signature", value: "v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=" },
          ],
        }).pipe(
          Effect.provide(
            resendWebhookLayer({
              signingSecrets: [Redacted.make("whsec_plJ3nmyCDGBKInavdOK15jsl")],
            }),
          ),
        );

        assert.strictEqual(verified.body, body);
        assert.strictEqual(String(verified.id), "msg_loFOjxBNrRLzqYUf");
        assert.strictEqual(String(verified.timestamp), "1731705121");
      }),
  );

  it.effect.prop(
    "authenticates exact generated UTF-8 bytes and rejects even one appended byte",
    {
      text: Schema.String.check(Schema.isMaxLength(100), Schema.isPattern(/^[^\uD800-\uDFFF]*$/u)),
    },
    ({ text }) =>
      Effect.gen(function* authenticateGeneratedWebhook() {
        yield* TestClock.setTime(epochMillis);
        const body = ` {"text":${JSON.stringify(text)}}\n`;
        const request = yield* signedRequest(body);
        const verifier = yield* ResendWebhookVerifier;
        const verified = yield* verifier.verify(request);
        assert.strictEqual(verified.body, body);

        const tampered = yield* verifier
          .verify({ ...request, body: `${body} ` })
          .pipe(Effect.result);

        assert(
          Result.isFailure(tampered) && tampered.failure instanceof EmailWebhookVerificationError,
        );
        assert.strictEqual(tampered.failure.reason, "invalid-signature");
      }).pipe(Effect.provide(resendWebhookLayer(configuration))),
  );

  it.effect(
    "accepts case-insensitive header names, rotation signatures and opaque non-JSON bodies without interpreting delivery",
    () =>
      Effect.gen(function* verifyRotatingResendKeys() {
        yield* TestClock.setTime(epochMillis);
        const request = yield* signedRequest("private raw body 😀\r\nnot JSON");
        const signature = `v2,YWJj v1,${Buffer.alloc(32).toString("base64")} ${signatureHeader(request)}`;

        const headers = replaceHeader(request, "svix-signature", signature).headers.map(
          (header) => ({ ...header, name: header.name.toUpperCase() }),
        );

        const verified = yield* verifyRequest({ ...request, headers }).pipe(
          Effect.provide(
            resendWebhookLayer({
              signingSecrets: [
                Redacted.make(`whsec_${Buffer.alloc(32, 1).toString("base64")}`),
                Redacted.make(`whsec_${Buffer.alloc(32, 2).toString("base64")}`),
                Redacted.make(`whsec_${Buffer.alloc(32, 3).toString("base64")}`),
                Redacted.make(secret.replace(/=+$/u, "")),
              ],
            }),
          ),
        );

        assert.strictEqual(verified.body, request.body);
        Reflect.set(verified, "body", "private-mutated-body");
        assert.strictEqual(verified.body, request.body);

        const again = yield* verifyRequest(request).pipe(
          Effect.provide(resendWebhookLayer(configuration)),
        );

        assert.deepStrictEqual(again, verified);
      }),
  );

  it.effect.each([-300_001, -300_000, -1, 0, 1, 300_000, 300_001])(
    "uses the runtime clock and exact millisecond freshness limits at offset %s",
    (offset) =>
      Effect.gen(function* enforceWebhookFreshness() {
        yield* TestClock.setTime(epochMillis + offset);
        const request = yield* signedRequest("private-body");

        const result = yield* verifyRequest(request).pipe(
          Effect.provide(resendWebhookLayer(configuration)),
          Effect.result,
        );

        if (Math.abs(offset) <= 300_000) {
          assert(Result.isSuccess(result));
        } else {
          assert(
            Result.isFailure(result) && result.failure instanceof EmailWebhookVerificationError,
          );
          assert.strictEqual(result.failure.reason, "timestamp-outside-tolerance");
        }
      }),
  );

  it.effect(
    "owns the acquired rotation list and tolerance, reads the clock per verification and returns detached immutable proof",
    () =>
      Effect.gen(function* ownWebhookAuthority() {
        yield* TestClock.setTime(epochMillis);

        const options = {
          signingSecrets: [Redacted.make(secret)] as const,
          tolerance: Duration.seconds(1),
        };

        const request = yield* signedRequest("private-body");
        const originalId = request.headers.find((header) => header.name === "svix-id");
        assert.isDefined(originalId);
        yield* Effect.gen(function* useOwnedWebhookAuthority() {
          const verifier = yield* ResendWebhookVerifier;
          Reflect.set(
            options.signingSecrets,
            "0",
            Redacted.make(`whsec_${Buffer.alloc(32, 1).toString("base64")}`),
          );
          options.tolerance = Duration.seconds(300);
          const proof = yield* verifier.verify(request);
          originalId.value = "private-mutated-id";
          assert.strictEqual(String(proof.id), "private-webhook-id");
          originalId.value = "private-webhook-id";
          yield* TestClock.adjust(Duration.millis(1001));
          const expired = yield* verifier.verify(request).pipe(Effect.result);
          assert(
            Result.isFailure(expired) && expired.failure instanceof EmailWebhookVerificationError,
          );
          assert.strictEqual(expired.failure.reason, "timestamp-outside-tolerance");
        }).pipe(Effect.provide(resendWebhookLayer(options)));
      }),
  );

  it.effect.each(["svix-id", "svix-timestamp", "svix-signature"])(
    "rejects missing or case-duplicated %s rather than merging ambiguous signing authority",
    (name) =>
      Effect.gen(function* refuseAmbiguousWebhookHeader() {
        yield* TestClock.setTime(epochMillis);
        const request = yield* signedRequest("private-body");
        const duplicate = request.headers.find((header) => header.name === name);
        assert.isDefined(duplicate);

        for (const headers of [
          request.headers.filter((header) => header.name !== name),
          [...request.headers, { ...duplicate, name: name.toUpperCase() }],
        ]) {
          const result = yield* verifyRequest({ ...request, headers }).pipe(
            Effect.provide(resendWebhookLayer(configuration)),
            Effect.result,
          );

          assert(
            Result.isFailure(result) && result.failure instanceof EmailWebhookVerificationError,
          );
          assert.strictEqual(result.failure.reason, "invalid-request");
        }
      }),
  );

  it.effect.each(["webhook-id", "webhook-timestamp", "webhook-signature"])(
    "refuses unsupported %s aliases even beside a valid Svix signature",
    (name) =>
      Effect.gen(function* refuseWebhookAliases() {
        yield* TestClock.setTime(epochMillis);
        const request = yield* signedRequest("private-body");

        const result = yield* verifyRequest({
          ...request,
          headers: [...request.headers, { name, value: "private-alias" }],
        }).pipe(Effect.provide(resendWebhookLayer(configuration)), Effect.result);

        assert(Result.isFailure(result) && result.failure instanceof EmailWebhookVerificationError);
        assert.strictEqual(result.failure.reason, "invalid-request");
      }),
  );

  it.effect.each([
    "",
    "01731705121",
    "+1731705121",
    "1731705121.0",
    "1.731705121e9",
    " 1731705121",
    "99999999999999999999",
    "-1",
  ])("rejects noncanonical timestamp %s before it can become authenticated metadata", (value) =>
    Effect.gen(function* refuseNoncanonicalWebhookTimestamp() {
      yield* TestClock.setTime(epochMillis);
      const request = yield* signedRequest("private-body", { timestamp: value });

      const result = yield* verifyRequest(request).pipe(
        Effect.provide(resendWebhookLayer(configuration)),
        Effect.result,
      );

      assert(Result.isFailure(result) && result.failure instanceof EmailWebhookVerificationError);
      assert.strictEqual(result.failure.reason, "invalid-request");
    }),
  );

  it.effect.each([
    "",
    "v1,AA==",
    `v1,${Buffer.alloc(32).toString("base64").slice(0, -1)}`,
    "v1,//////////////////////////////////////////9=",
    "v1,invalid-base64",
    "v1,YWJj,v1,YWJj",
    " v1,YWJj",
    "v1,YWJj  v2,YWJj",
  ])(
    "rejects malformed signature framing without throwing or accepting other candidates (%s)",
    (value) =>
      Effect.gen(function* refuseMalformedWebhookSignature() {
        yield* TestClock.setTime(epochMillis);
        const request = yield* signedRequest("private-body");

        for (const signatures of [value, `${signatureHeader(request)} ${value}`]) {
          const result = yield* verifyRequest(
            replaceHeader(request, "svix-signature", signatures),
          ).pipe(Effect.provide(resendWebhookLayer(configuration)), Effect.result);

          assert(
            Result.isFailure(result) && result.failure instanceof EmailWebhookVerificationError,
          );
          assert.strictEqual(result.failure.reason, "invalid-request");
        }
      }),
  );

  it.effect(
    "does not authenticate unknown versions, changed message identity, changed time or a wrong key",
    () =>
      Effect.gen(function* rejectWebhookForgery() {
        yield* TestClock.setTime(epochMillis);
        const request = yield* signedRequest("private-body");

        const changedTime = replaceHeader(
          request,
          "svix-timestamp",
          String(epochMillis / 1000 + 1),
        );

        const changedId = replaceHeader(request, "svix-id", "other-private-id");

        const unknown = replaceHeader(
          request,
          "svix-signature",
          signatureHeader(request).replace("v1,", "v2,"),
        );

        for (const input of [changedTime, changedId, unknown]) {
          const result = yield* verifyRequest(input).pipe(
            Effect.provide(resendWebhookLayer(configuration)),
            Effect.result,
          );

          assert(
            Result.isFailure(result) && result.failure instanceof EmailWebhookVerificationError,
          );
          assert.strictEqual(result.failure.reason, "invalid-signature");
        }

        const wrongKey = yield* verifyRequest(request).pipe(
          Effect.provide(
            resendWebhookLayer({
              signingSecrets: [Redacted.make(`whsec_${Buffer.alloc(32, 2).toString("base64")}`)],
            }),
          ),
          Effect.result,
        );

        assert(
          Result.isFailure(wrongKey) && wrongKey.failure instanceof EmailWebhookVerificationError,
        );
        assert.strictEqual(wrongKey.failure.reason, "invalid-signature");
      }),
  );

  it.effect(
    "bounds actual multibyte body bytes without truncation and rejects extra request/header controls",
    () =>
      Effect.gen(function* boundWebhookInputs() {
        yield* TestClock.setTime(epochMillis);
        const body = `${"界".repeat(349_525)}x`;
        assert.strictEqual(Buffer.byteLength(body), 1_048_576);
        const request = yield* signedRequest(body);

        const verified = yield* verifyRequest(request).pipe(
          Effect.provide(resendWebhookLayer(configuration)),
        );

        assert.strictEqual(verified.body, body);
        const extra = { ...request, "private-option": "private-value" };

        for (const input of [
          { ...request, body: `${body}x` },
          { ...request, body: "\uD800" },
          extra,
          {
            ...request,
            headers: [...request.headers, { name: "x-private", value: "private\r\nheader" }],
          },
          {
            ...request,
            headers: [
              ...request.headers,
              ...Array.from({ length: 62 }, () => ({ name: "x-private", value: "private" })),
            ],
          },
          {
            ...request,
            headers: [
              ...request.headers,
              ...Array.from({ length: 3 }, () => ({ name: "x-private", value: "x".repeat(8192) })),
            ],
          },
        ]) {
          const result = yield* verifyRequest(input).pipe(
            Effect.provide(resendWebhookLayer(configuration)),
            Effect.result,
          );

          assert(
            Result.isFailure(result) && result.failure instanceof EmailWebhookVerificationError,
          );
          assert.strictEqual(result.failure.reason, "invalid-request");
          assert.notInclude(JSON.stringify(result.failure), "private");
        }
      }),
  );

  it.effect.each([
    "",
    "private-invalid-secret",
    "whsec_AA==",
    "whsec_AAAAAAAAAAAAAAAAAAAAAA=",
    "whsec_AAAAAAAAAAAAAAAAAAAAAA===",
    "whsec_AAAAAAAAAAAAAAAAAAAAA/==",
    `whsec_${Buffer.alloc(257).toString("base64")}`,
  ])("rejects unsafe signing-secret configuration without retaining its value (%s)", (value) =>
    Effect.gen(function* refuseUnsafeWebhookSecret() {
      const result = yield* Effect.service(ResendWebhookVerifier).pipe(
        Effect.provide(resendWebhookLayer({ signingSecrets: [Redacted.make(value)] })),
        Effect.result,
      );

      assert(Result.isFailure(result) && result.failure instanceof EmailConfigurationError);
      assert.strictEqual(result.failure.issues[0]?.path.split(".")[0], "signingSecrets");
      assert.notInclude(JSON.stringify(result.failure), value || "private-invalid-secret");
    }),
  );

  it.effect.each([Duration.zero, Duration.millis(-1), Duration.infinity, Duration.millis(300_001)])(
    "never disables or widens the maximum freshness window through invalid tolerance %s",
    (tolerance) =>
      Effect.gen(function* refuseUnsafeWebhookTolerance() {
        const result = yield* Effect.service(ResendWebhookVerifier).pipe(
          Effect.provide(resendWebhookLayer({ ...configuration, tolerance })),
          Effect.result,
        );

        assert(Result.isFailure(result) && result.failure instanceof EmailConfigurationError);
        assert.strictEqual(result.failure.issues[0]?.path, "tolerance");
      }),
  );

  it.effect("enforces bounded supplied key rotation and signature lists", () =>
    Effect.gen(function* boundWebhookRotation() {
      yield* TestClock.setTime(epochMillis);

      for (const signingSecrets of [[], Array.from({ length: 5 }, () => Redacted.make(secret))]) {
        const options = { ...configuration };
        Reflect.set(options, "signingSecrets", signingSecrets);

        const result = yield* Effect.service(ResendWebhookVerifier).pipe(
          Effect.provide(resendWebhookLayer(options)),
          Effect.result,
        );

        assert(Result.isFailure(result) && result.failure instanceof EmailConfigurationError);
      }

      const request = yield* signedRequest("private-body");

      for (const count of [16, 17]) {
        const repeated = replaceHeader(
          request,
          "svix-signature",
          Array.from({ length: count }, () => signatureHeader(request)).join(" "),
        );

        const result = yield* verifyRequest(repeated).pipe(
          Effect.provide(resendWebhookLayer(configuration)),
          Effect.result,
        );

        assert.strictEqual(Result.isSuccess(result), count === 16);
      }
    }),
  );

  it.effect(
    "accepts a publicly decoded request and keeps repeated authenticated delivery IDs visible for application replay storage",
    () =>
      Effect.gen(function* authenticateRepeatedWebhook() {
        yield* TestClock.setTime(epochMillis);
        const request = yield* signedRequest("private-body");
        const parsed = yield* Schema.decodeEffect(ResendWebhookRequestSchema)(request);
        const verifier = yield* ResendWebhookVerifier;
        const first = yield* verifier.verify(parsed);
        const duplicate = yield* verifier.verify(parsed);
        assert.deepStrictEqual(first, duplicate);
      }).pipe(Effect.provide(resendWebhookLayer(configuration))),
  );

  it.effect(
    "excludes raw payload, signing credentials, signatures and handles from actual NativeSpan exits",
    () =>
      Effect.gen(function* traceWebhookPrivacy() {
        yield* TestClock.setTime(epochMillis);
        const trace = yield* startEmailTraceFixture();

        const request = yield* signedRequest(
          "private-recipient@fictional.invalid private-message-id",
        );

        yield* Effect.gen(function* verifyPrivateWebhook() {
          const verifier = yield* ResendWebhookVerifier;
          yield* verifier.verify(request);
          yield* verifier.verify({ ...request, body: "private-tampered-body" }).pipe(Effect.result);
        }).pipe(
          Effect.provide(resendWebhookLayer(configuration)),
          Effect.provideService(Tracer.Tracer, trace.tracer),
        );
        const diagnostics = yield* trace.diagnostics;
        assert.include(diagnostics, "ResendWebhook.verify");

        for (const value of [
          request.body,
          secret,
          "private-webhook-id",
          signatureHeader(request),
          "private-tampered-body",
        ]) {
          assert.notInclude(diagnostics, value);
        }
      }),
  );

  it.effect(
    "preserves interruption and clock defects instead of converting them to verification errors",
    () =>
      Effect.gen(function* preserveWebhookExits() {
        const request = yield* signedRequest("private-body");
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

        const interrupted = yield* verifyRequest(request).pipe(
          Effect.provide(resendWebhookLayer(configuration)),
          Effect.provideService(Clock.Clock, {
            ...delegatedClock,
            currentTimeMillis: Deferred.succeed(ready, true).pipe(Effect.andThen(Effect.never)),
          }),
          Effect.forkScoped,
        );

        yield* Deferred.await(ready);
        yield* Fiber.interrupt(interrupted);
        assert(Exit.hasInterrupts(yield* Fiber.await(interrupted)));
        const trace = yield* startEmailTraceFixture();

        const defect = yield* verifyRequest(request).pipe(
          Effect.provide(resendWebhookLayer(configuration)),
          Effect.provideService(Clock.Clock, {
            ...delegatedClock,
            currentTimeMillis: Effect.die("private-clock-defect"),
          }),
          Effect.provideService(Tracer.Tracer, trace.tracer),
          Effect.exit,
        );

        assert(Exit.hasDies(defect));
        assert.notInclude(yield* trace.diagnostics, "private-clock-defect");
      }),
  );
});
