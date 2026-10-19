import { createHmac, timingSafeEqual } from "node:crypto";
import { Context, Duration, Effect, Layer, Redacted, Schema } from "effect";
import { emailBase64DecodedBytes, emailBase64HasCanonicalPadding } from "./email-base64.js";
import { EmailConfigurationError } from "./email-configuration-error.js";
import { emailInputIssues } from "./email-input-issues.js";
import { emailOperationSpan } from "./email-tracing.js";
import {
  EmailWebhookToleranceSchema,
  emailWebhookDefaultToleranceMillis,
  parseEmailWebhookFreshness,
} from "./email-webhook-freshness.js";
import { EmailWebhookVerificationError } from "./email-webhook-verification-error.js";
import { EmailWebhookBodySchema } from "./email-webhook-body.js";
import {
  ResendWebhookIdSchema,
  ResendWebhookTimestampSchema,
  VerifiedResendWebhookSchema,
} from "./resend-webhook-proof.js";
import type { VerifiedResendWebhook } from "./resend-webhook-proof.js";

export { EmailWebhookVerificationError } from "./email-webhook-verification-error.js";

export { EmailWebhookNormalizationError } from "./email-webhook-normalization-error.js";

export { ResendWebhookEventSchema, parseResendWebhookEvent } from "./resend-webhook-event.js";

export type { ResendWebhookEvent } from "./resend-webhook-event.js";

export type { VerifiedResendWebhook } from "./resend-webhook-proof.js";

export const ResendWebhookRequestSchema = Schema.Struct({
  body: EmailWebhookBodySchema,
  headers: Schema.Array(
    Schema.Struct({
      name: Schema.String.check(
        Schema.isMaxLength(78),
        Schema.isPattern(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u),
      ),
      value: Schema.String.check(Schema.isMaxLength(8192), Schema.isPattern(/^[\u0020-\u007E]*$/u)),
    }),
  ).check(
    Schema.isMaxLength(64),
    Schema.makeFilter(
      (headers) =>
        headers.reduce(
          (bytes, header) => bytes + header.name.length + header.value.length + 2,
          0,
        ) <= 16_384,
    ),
  ),
});

export type ResendWebhookRequest = typeof ResendWebhookRequestSchema.Encoded;

const WebhookSignature = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9+/]{43}=$/u),
  Schema.makeFilter(emailBase64HasCanonicalPadding),
);

const WebhookSignatureEntry = Schema.String.check(
  Schema.isMaxLength(512),
  Schema.isPattern(/^v[1-9][0-9]{0,2},[A-Za-z0-9+/]+={0,2}$/u),
);

const SignedWebhookHeaders = Schema.Struct({
  id: ResendWebhookIdSchema,
  signatures: Schema.NonEmptyArray(WebhookSignatureEntry).check(Schema.isMaxLength(16)),
  timestamp: ResendWebhookTimestampSchema,
});

const canonicalSecretContent = (secret: string): string => {
  const content = secret.slice(6);

  return content.padEnd(Math.ceil(content.length / 4) * 4, "=");
};

const ResendWebhookConfiguration = Schema.Struct({
  signingSecrets: Schema.NonEmptyArray(
    Schema.Redacted(
      Schema.String.check(
        Schema.isMinLength(28),
        Schema.isMaxLength(350),
        Schema.isPattern(/^whsec_[A-Za-z0-9+/]+={0,2}$/u),
        Schema.makeFilter((secret) => {
          const content = canonicalSecretContent(secret);

          return (
            (!secret.includes("=") || secret.slice(6).length % 4 === 0) &&
            emailBase64HasCanonicalPadding(content) &&
            emailBase64DecodedBytes(content) >= 16 &&
            emailBase64DecodedBytes(content) <= 256
          );
        }),
      ),
    ),
  ).check(Schema.isMaxLength(4)),
  tolerance: Schema.optionalKey(EmailWebhookToleranceSchema),
});

export type ResendWebhookOptions = typeof ResendWebhookConfiguration.Type;

export interface IResendWebhookVerifier {
  readonly verify: (
    request: ResendWebhookRequest,
  ) => Effect.Effect<VerifiedResendWebhook, EmailWebhookVerificationError>;
}

export class ResendWebhookVerifier extends Context.Service<
  ResendWebhookVerifier,
  IResendWebhookVerifier
>()("@corvencore/email-sdk/ResendWebhookVerifier") {}

const parseResendSigningHeaders = Effect.fnUntraced(function* parseResendSigningHeaders(
  headers: typeof ResendWebhookRequestSchema.Type.headers,
) {
  const values = (name: string) =>
    headers.filter((header) => header.name.toLowerCase() === name).map((header) => header.value);

  const ids = values("svix-id");
  const timestamps = values("svix-timestamp");
  const signatures = values("svix-signature");

  if (
    ids.length !== 1 ||
    timestamps.length !== 1 ||
    signatures.length !== 1 ||
    headers.some((header) =>
      ["webhook-id", "webhook-timestamp", "webhook-signature"].includes(header.name.toLowerCase()),
    )
  ) {
    return yield* new EmailWebhookVerificationError({ reason: "invalid-request" });
  }

  const [id] = ids;
  const [timestamp] = timestamps;
  const [signature] = signatures;

  const parsed = yield* Schema.decodeUnknownEffect(SignedWebhookHeaders)({
    id,
    signatures: signature?.split(" "),
    timestamp,
  }).pipe(Effect.mapError(() => new EmailWebhookVerificationError({ reason: "invalid-request" })));

  const candidates: Buffer[] = [];

  for (const entry of parsed.signatures) {
    const [version, content] = entry.split(",");

    if (version === "v1") {
      const signatureValue = yield* Schema.decodeUnknownEffect(WebhookSignature)(content).pipe(
        Effect.mapError(() => new EmailWebhookVerificationError({ reason: "invalid-request" })),
      );

      candidates.push(Buffer.from(signatureValue, "base64"));
    }
  }

  return { candidates, id: parsed.id, timestamp: parsed.timestamp };
});

export const resendWebhookLayer = (
  options: ResendWebhookOptions,
): Layer.Layer<ResendWebhookVerifier, EmailConfigurationError> =>
  Layer.effect(
    ResendWebhookVerifier,
    Effect.gen(function* acquireResendWebhookVerifier() {
      const configuration = yield* Schema.decodeEffect(ResendWebhookConfiguration, {
        errors: "all",
        onExcessProperty: "error",
      })(options).pipe(
        Effect.mapError(
          (cause) => new EmailConfigurationError({ issues: emailInputIssues(cause) }),
        ),
      );

      const secrets = Object.freeze([...configuration.signingSecrets]);

      const toleranceMillis =
        configuration.tolerance === undefined
          ? emailWebhookDefaultToleranceMillis
          : Duration.toMillis(configuration.tolerance);

      const verify = Effect.fnUntraced(function* verifyResendWebhook(
        request: ResendWebhookRequest,
      ): Effect.fn.Return<VerifiedResendWebhook, EmailWebhookVerificationError> {
        const parsed = yield* Schema.decodeEffect(ResendWebhookRequestSchema, {
          errors: "all",
          onExcessProperty: "error",
        })(request).pipe(
          Effect.mapError(() => new EmailWebhookVerificationError({ reason: "invalid-request" })),
        );

        const signed = yield* parseResendSigningHeaders(parsed.headers);
        yield* parseEmailWebhookFreshness(signed.timestamp, toleranceMillis);

        let matched = false;

        for (const secret of secrets) {
          const digest = createHmac(
            "sha256",
            Buffer.from(canonicalSecretContent(Redacted.value(secret)), "base64"),
          )
            .update(`${signed.id}.${signed.timestamp}.${parsed.body}`, "utf-8")
            .digest();

          for (const candidate of signed.candidates) {
            matched = timingSafeEqual(digest, candidate) || matched;
          }
        }

        if (!matched) {
          return yield* new EmailWebhookVerificationError({ reason: "invalid-signature" });
        }

        return Object.freeze(
          VerifiedResendWebhookSchema.make({
            body: parsed.body,
            id: signed.id,
            timestamp: signed.timestamp,
          }),
        );
      }, emailOperationSpan("ResendWebhook.verify"));

      return ResendWebhookVerifier.of({ verify });
    }),
  );
