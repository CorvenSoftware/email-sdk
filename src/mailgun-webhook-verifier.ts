import { createHmac, timingSafeEqual } from "node:crypto";
import { Context, Duration, Effect, Layer, Redacted, Schema } from "effect";
import { EmailConfigurationError } from "./email-configuration-error.js";
import { emailInputIssues } from "./email-input-issues.js";
import { emailOperationSpan } from "./email-tracing.js";
import {
  EmailWebhookToleranceSchema,
  emailWebhookDefaultToleranceMillis,
  parseEmailWebhookFreshness,
} from "./email-webhook-freshness.js";
import { EmailWebhookVerificationError } from "./email-webhook-verification-error.js";

export { EmailWebhookVerificationError } from "./email-webhook-verification-error.js";

export {
  EmailWebhookNormalizationError,
  MailgunWebhookEventSchema,
  MailgunWebhookRecipientSchema,
  parseMailgunWebhookEvent,
} from "./mailgun-webhook-event.js";

export type { MailgunWebhookEvent, MailgunWebhookRecipient } from "./mailgun-webhook-event.js";

const MailgunTimestampSeconds = Schema.String.check(
  Schema.isPattern(/^(?:0|[1-9][0-9]{0,9})$/u),
).pipe(Schema.brand("MailgunWebhookTimestampSeconds"));

const MailgunToken = Schema.String.check(Schema.isPattern(/^[\u0021-\u007E]{50}$/u)).pipe(
  Schema.brand("MailgunWebhookToken"),
);

const MailgunSignatureDigest = Schema.String.check(Schema.isPattern(/^[a-fA-F0-9]{64}$/u));

const MailgunSignatureField = Schema.Literals(["signature", "parent-signature"]);

export const MailgunWebhookSignatureSchema = Schema.Struct({
  "parent-signature": Schema.optionalKey(MailgunSignatureDigest),
  signature: MailgunSignatureDigest,
  timestamp: Schema.Union([
    MailgunTimestampSeconds,
    Schema.Finite.check(Schema.isInt(), Schema.isBetween({ maximum: 9_999_999_999, minimum: 0 })),
  ]),
  token: MailgunToken,
});

export type MailgunWebhookSignature = typeof MailgunWebhookSignatureSchema.Encoded;

const VerifiedMailgunSignature = Schema.Struct({
  signatureField: MailgunSignatureField,
  timestamp: MailgunTimestampSeconds,
  token: MailgunToken,
}).pipe(Schema.brand("VerifiedMailgunWebhookSignature"));

export type VerifiedMailgunWebhookSignature = typeof VerifiedMailgunSignature.Type;

const MailgunWebhookConfiguration = Schema.Struct({
  signatureField: MailgunSignatureField,
  signingSecrets: Schema.NonEmptyArray(
    Schema.Redacted(
      Schema.String.check(
        Schema.isMinLength(16),
        Schema.isMaxLength(256),
        Schema.isPattern(/^[\u0021-\u007E]+$/u),
      ),
    ),
  ).check(Schema.isMaxLength(4)),
  tolerance: Schema.optionalKey(EmailWebhookToleranceSchema),
});

export type MailgunWebhookOptions = typeof MailgunWebhookConfiguration.Type;

export interface IMailgunWebhookVerifier {
  readonly verifySignature: (
    request: MailgunWebhookSignature,
  ) => Effect.Effect<VerifiedMailgunWebhookSignature, EmailWebhookVerificationError>;
}

export class MailgunWebhookVerifier extends Context.Service<
  MailgunWebhookVerifier,
  IMailgunWebhookVerifier
>()("@corven/email-sdk/MailgunWebhookVerifier") {}

export const mailgunWebhookLayer = (
  options: MailgunWebhookOptions,
): Layer.Layer<MailgunWebhookVerifier, EmailConfigurationError> =>
  Layer.effect(
    MailgunWebhookVerifier,
    Effect.gen(function* acquireMailgunWebhookVerifier() {
      const configuration = yield* Schema.decodeEffect(MailgunWebhookConfiguration, {
        errors: "all",
        onExcessProperty: "error",
      })(options).pipe(
        Effect.mapError(
          (cause) => new EmailConfigurationError({ issues: emailInputIssues(cause) }),
        ),
      );

      const secrets = Object.freeze([...configuration.signingSecrets]);
      const { signatureField } = configuration;

      const toleranceMillis =
        configuration.tolerance === undefined
          ? emailWebhookDefaultToleranceMillis
          : Duration.toMillis(configuration.tolerance);

      const verifySignature = Effect.fnUntraced(function* verifyMailgunWebhookSignature(
        request: MailgunWebhookSignature,
      ): Effect.fn.Return<VerifiedMailgunWebhookSignature, EmailWebhookVerificationError> {
        const parsed = yield* Schema.decodeEffect(MailgunWebhookSignatureSchema, {
          errors: "all",
          onExcessProperty: "error",
        })(request).pipe(
          Effect.mapError(() => new EmailWebhookVerificationError({ reason: "invalid-request" })),
        );

        const signature = parsed[signatureField];

        if (signature === undefined) {
          return yield* new EmailWebhookVerificationError({ reason: "invalid-request" });
        }

        const timestamp = MailgunTimestampSeconds.make(String(parsed.timestamp));
        yield* parseEmailWebhookFreshness(timestamp, toleranceMillis);
        const candidate = Buffer.from(signature, "hex");
        let matched = false;

        for (const secret of secrets) {
          const digest = createHmac("sha256", Redacted.value(secret))
            .update(`${timestamp}${parsed.token}`, "utf-8")
            .digest();

          matched = timingSafeEqual(digest, candidate) || matched;
        }

        if (!matched) {
          return yield* new EmailWebhookVerificationError({ reason: "invalid-signature" });
        }

        return Object.freeze(
          VerifiedMailgunSignature.make({ signatureField, timestamp, token: parsed.token }),
        );
      }, emailOperationSpan("MailgunWebhook.verifySignature"));

      return MailgunWebhookVerifier.of({ verifySignature });
    }),
  );
