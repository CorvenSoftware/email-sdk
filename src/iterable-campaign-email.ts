import { Context, DateTime, Effect, Layer, Match, Redacted, Schema } from "effect";
import type { Result, Scope } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import type { HttpClientResponse } from "effect/http";
import { EmailConfigurationError } from "./email-configuration-error.js";
import { EmailDeliveryUnknown } from "./email-delivery-unknown.js";
import type { EmailDeliveryPolicy } from "./email-delivery-policy.js";
import type { EmailRetryObserver, EmailRetryRestriction } from "./email-retry-decision.js";
import type { EmailSendError, EmailSubmissionError } from "./email-errors.js";
import { EmailHttpCredentialSchema } from "./email-http-credential.js";
import { readEmailHttpJson } from "./email-http-response.js";
import { emailInputIssues } from "./email-input-issues.js";
import { EmailInvalidMessage } from "./email-invalid-message.js";
import { EmailInvalidOptions } from "./email-invalid-options.js";
import { EmailReceiptSchema } from "./email-message.js";
import type { EmailReceipt } from "./email-message.js";
import { emailNativeOperations } from "./email-native-operations.js";
import type {
  EmailBatchOptionsInput,
  EmailPolicyOptionsInput as EmailSendOptionsInput,
  EmailPolicyOptionsSchema as EmailSendOptionsSchema,
} from "./email-preparation.js";
import { EmailRejected } from "./email-rejected.js";
import { EmailSenderIdempotencySchema, supportsEmailIdempotencyKey } from "./email-sender.js";
import type { EmailSenderIdempotency } from "./email-sender.js";
import { parseEmailReplayPolicy, submitEmailWithPolicy } from "./email-submission-policy.js";
import { emailOperationSpan } from "./email-tracing.js";
import { IterableCampaignJobSchema, ownIterableJob } from "./iterable-campaign-job.js";
import type {
  IterableCampaignJob,
  IterableCampaignJobInput,
  IterableCampaignRequest,
} from "./iterable-campaign-job.js";

export {
  IterableCampaignJobSchema,
  IterableCampaignRequestSchema,
} from "./iterable-campaign-job.js";

export type {
  IterableCampaignJob,
  IterableCampaignJobInput,
  IterableCampaignRequest,
} from "./iterable-campaign-job.js";

const IterableConfiguration = Schema.Struct({
  apiKey: EmailHttpCredentialSchema,
  campaignAuthority: Schema.Literal("AuthorizeProviderManagedCampaign"),
  contactWrites: Schema.Literal("AuthorizeProfileCreation"),
  dataRetention: Schema.Literal("AuthorizePersistedSendData"),
  projectIdentity: Schema.Literal("EmailBased"),
  region: Schema.Literals(["US", "EU"]),
  tracking: Schema.Literal("AuthorizeCampaignTracking"),
});

export type IterableCampaignOptions = typeof IterableConfiguration.Type;

export interface IIterableCampaignEmail {
  readonly idempotency: EmailSenderIdempotency;
  readonly validate: (
    job: IterableCampaignJobInput,
    options?: EmailSendOptionsInput,
  ) => Effect.Effect<
    IterableCampaignJob,
    EmailInvalidMessage | EmailInvalidOptions | EmailRejected
  >;
  readonly send: (
    job: IterableCampaignJobInput,
    options?: EmailSendOptionsInput,
  ) => Effect.Effect<EmailReceipt, EmailSendError>;
  readonly sendAll: (
    requests: readonly IterableCampaignRequest[],
    options?: EmailBatchOptionsInput,
  ) => Effect.Effect<readonly Result.Result<EmailReceipt, EmailSendError>[], EmailInvalidOptions>;
}

export class IterableCampaignEmail extends Context.Service<
  IterableCampaignEmail,
  IIterableCampaignEmail
>()("@corven/email-sdk/IterableCampaignEmail") {}

interface PreparedIterableSubmission {
  readonly job: IterableCampaignJob;
  readonly payload: string;
  readonly policy: EmailDeliveryPolicy;
}

const IterableResponse = Schema.Struct({
  code: Schema.String.check(Schema.isMaxLength(128)),
  msg: Schema.String.check(Schema.isMaxLength(4096)),
});

const readIterableAcknowledgement = Effect.fnUntraced(function* readIterableAcknowledgement(
  response: HttpClientResponse.HttpClientResponse,
): Effect.fn.Return<EmailReceipt, EmailSubmissionError> {
  if (response.status === 200 || response.status === 400 || response.status === 401) {
    const json = yield* readEmailHttpJson(response, "iterable");

    const body = yield* Schema.decodeUnknownEffect(IterableResponse)(json).pipe(
      Effect.mapError(
        () =>
          new EmailDeliveryUnknown({
            provider: "iterable",
            reason: "invalid-response",
            status: response.status,
          }),
      ),
    );

    if (response.status === 200 && body.code === "Success") {
      return Object.freeze(EmailReceiptSchema.cases.Accepted.make({ provider: "iterable" }));
    }

    if (response.status === 401 && (body.code === "BadApiKey" || body.code === "Unauthorized")) {
      return yield* new EmailRejected({
        provider: "iterable",
        reason: "authentication",
        status: response.status,
      });
    }

    if (
      response.status === 400 &&
      [
        "BadJsonBody",
        "BadParams",
        "InvalidEmailAddressError",
        "InvalidUserIdError",
        "RequestFieldsTypesMismatched",
      ].includes(body.code)
    ) {
      return yield* new EmailRejected({
        provider: "iterable",
        reason: "invalid-message",
        status: response.status,
      });
    }
  }

  return yield* new EmailDeliveryUnknown({
    provider: "iterable",
    reason: response.status >= 500 ? "server-error" : "unexpected-status",
    status: response.status,
  });
});

export const iterableCampaignLayer = (
  options: IterableCampaignOptions,
  policy?: EmailDeliveryPolicy,
  observer?: EmailRetryObserver,
  restriction?: EmailRetryRestriction,
): Layer.Layer<IterableCampaignEmail, EmailConfigurationError, HttpClient.HttpClient> =>
  Layer.effect(
    IterableCampaignEmail,
    Effect.gen(function* acquireIterableCampaignEmail() {
      const configuration = yield* Schema.decodeEffect(IterableConfiguration, {
        errors: "all",
        onExcessProperty: "error",
      })(options).pipe(
        Effect.mapError(
          (cause) => new EmailConfigurationError({ issues: emailInputIssues(cause) }),
        ),
      );

      const client = (yield* HttpClient.HttpClient).pipe(HttpClient.withScope);
      const idempotency = Object.freeze(EmailSenderIdempotencySchema.cases.None.make({}));

      const resolvedPolicy = yield* parseEmailReplayPolicy(idempotency, policy).pipe(
        Effect.mapError(
          (cause) => new EmailConfigurationError({ issues: emailInputIssues(cause) }),
        ),
      );

      const origin = Match.value(configuration.region).pipe(
        Match.when("US", () => "https://api.iterable.com"),
        Match.when("EU", () => "https://api.eu.iterable.com"),
        Match.exhaustive,
      );

      const prepare = Effect.fnUntraced(function* prepareIterableJob(
        parsed: IterableCampaignJob,
        parsedOptions: typeof EmailSendOptionsSchema.Type,
      ): Effect.fn.Return<
        PreparedIterableSubmission,
        EmailInvalidMessage | EmailInvalidOptions | EmailRejected
      > {
        const job = ownIterableJob(parsed);

        if (!supportsEmailIdempotencyKey(idempotency, parsedOptions.idempotencyKey)) {
          return yield* new EmailRejected({
            provider: "iterable",
            reason: "unsupported-idempotency",
          });
        }

        const effectivePolicy = yield* parseEmailReplayPolicy(
          idempotency,
          parsedOptions.policy ?? resolvedPolicy,
        ).pipe(
          Effect.mapError(
            (cause) =>
              new EmailInvalidOptions({
                issues: emailInputIssues(cause).map((issue) => ({
                  ...issue,
                  path: issue.path === "<root>" ? "policy" : `policy.${issue.path}`,
                })),
              }),
          ),
        );

        if (job.sendAt !== undefined) {
          const delta =
            DateTime.toEpochMillis(job.sendAt) - DateTime.toEpochMillis(yield* DateTime.now);

          if (delta <= 0 || delta > 365 * 24 * 60 * 60 * 1000) {
            return yield* new EmailInvalidMessage({
              issues: [
                {
                  path: "sendAt",
                  problem: "Iterable scheduling requires a future UTC second within 365 days",
                },
              ],
            });
          }
        }

        const payload = JSON.stringify({
          allowRepeatMarketingSends: false,
          campaignId: job.campaignId,
          dataFields: job.dataFields,
          metadata: job.metadata,
          recipientEmail: job.recipientEmail,
          sendAt:
            job.sendAt === undefined
              ? undefined
              : DateTime.formatIso(job.sendAt)
                  .replace("T", " ")
                  .replace(/\.000Z$/u, ""),
        });

        if (new TextEncoder().encode(payload).byteLength > 65_536) {
          return yield* new EmailInvalidMessage({
            issues: [
              {
                path: "dataFields",
                problem: "Iterable campaign payload must fit within the local 64 KiB UTF-8 budget",
              },
            ],
          });
        }

        return Object.freeze({ job, payload, policy: effectivePolicy });
      });

      const submit = Effect.fnUntraced(
        function* submitIterableJob(
          prepared: PreparedIterableSubmission,
        ): Effect.fn.Return<EmailReceipt, EmailSubmissionError, Scope.Scope> {
          if (
            prepared.job.sendAt !== undefined &&
            DateTime.toEpochMillis(prepared.job.sendAt) <=
              DateTime.toEpochMillis(yield* DateTime.now)
          ) {
            return yield* new EmailRejected({ provider: "iterable", reason: "invalid-message" });
          }

          const request = HttpClientRequest.post(`${origin}/api/email/target`).pipe(
            HttpClientRequest.setHeader("Api-Key", Redacted.value(configuration.apiKey)),
            HttpClientRequest.acceptJson,
            HttpClientRequest.bodyText(prepared.payload, "application/json"),
          );

          const response = yield* client.execute(request).pipe(
            Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
            Effect.mapError(
              () => new EmailDeliveryUnknown({ provider: "iterable", reason: "transport" }),
            ),
          );

          return yield* readIterableAcknowledgement(response);
        },
        Effect.scoped,
        emailOperationSpan("Iterable.submit"),
      );

      return IterableCampaignEmail.of({
        idempotency,
        ...emailNativeOperations({
          jobOf: (prepared: PreparedIterableSubmission) => prepared.job,
          jobSchema: IterableCampaignJobSchema,
          prepare,
          spans: {
            send: "Iterable.send",
            sendAll: "Iterable.sendAll",
            validate: "Iterable.validate",
          },
          submit: (prepared) =>
            submitEmailWithPolicy(
              submit(prepared),
              { idempotency, provider: "iterable" },
              undefined,
              prepared.policy,
              observer,
              restriction,
            ),
        }),
      });
    }),
  );
