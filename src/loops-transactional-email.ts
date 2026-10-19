import { Context, Effect, Layer, Redacted, Schema } from "effect";
import type { Result, Scope } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import type { HttpClientResponse } from "effect/http";
import { LoopsTransactionalJobSchema, ownLoopsJob } from "./loops-transactional-job.js";
import type {
  LoopsTransactionalJob,
  LoopsTransactionalJobInput,
  LoopsTransactionalRequest,
} from "./loops-transactional-job.js";

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
import type { EmailIdempotencyKey, EmailReceipt } from "./email-message.js";
import type {
  EmailPolicyOptionsSchema as EmailSendOptionsSchema,
  EmailBatchOptionsInput,
  EmailPolicyOptionsInput as EmailSendOptionsInput,
} from "./email-preparation.js";
import { emailNativeOperations } from "./email-native-operations.js";
import { EmailRejected } from "./email-rejected.js";
import {
  EmailSenderIdempotencySchema,
  ownEmailSenderIdempotency,
  supportsEmailIdempotencyKey,
} from "./email-sender.js";
import type { EmailSenderIdempotency } from "./email-sender.js";
import { parseEmailReplayPolicy, submitEmailWithPolicy } from "./email-submission-policy.js";
import { emailOperationSpan } from "./email-tracing.js";

export {
  LoopsTransactionalJobSchema,
  LoopsTransactionalRequestSchema,
} from "./loops-transactional-job.js";

export type {
  LoopsTransactionalJob,
  LoopsTransactionalJobInput,
  LoopsTransactionalRequest,
} from "./loops-transactional-job.js";

interface PreparedLoopsSubmission {
  readonly job: LoopsTransactionalJob;
  readonly key: EmailIdempotencyKey | undefined;
  readonly payload: string;
  readonly policy: EmailDeliveryPolicy;
}

const LoopsConfiguration = Schema.Struct({
  apiKey: EmailHttpCredentialSchema,
  attachments: Schema.Literals(["Disabled", "AccountEnabled"]),
  templateAuthority: Schema.Literal("ProviderManaged"),
});

export type LoopsTransactionalOptions = typeof LoopsConfiguration.Type;

export interface ILoopsTransactionalEmail {
  readonly idempotency: EmailSenderIdempotency;
  readonly validate: (
    job: LoopsTransactionalJobInput,
    options?: EmailSendOptionsInput,
  ) => Effect.Effect<
    LoopsTransactionalJob,
    EmailInvalidMessage | EmailInvalidOptions | EmailRejected
  >;
  readonly send: (
    job: LoopsTransactionalJobInput,
    options?: EmailSendOptionsInput,
  ) => Effect.Effect<EmailReceipt, EmailSendError>;
  readonly sendAll: (
    requests: readonly LoopsTransactionalRequest[],
    options?: EmailBatchOptionsInput,
  ) => Effect.Effect<readonly Result.Result<EmailReceipt, EmailSendError>[], EmailInvalidOptions>;
}

export class LoopsTransactionalEmail extends Context.Service<
  LoopsTransactionalEmail,
  ILoopsTransactionalEmail
>()("@corvencore/email-sdk/LoopsTransactionalEmail") {}

const buildLoopsPayload = (job: LoopsTransactionalJob) => ({
  addToAudience: false,
  attachments: job.attachments?.map((attachment) => ({
    contentType: attachment.contentType,
    data: attachment.contentBase64,
    filename: attachment.filename,
  })),
  dataVariables: job.dataVariables,
  email: job.email,
  transactionalId: job.transactionalId,
});

const LoopsAcknowledgement = Schema.Struct({ success: Schema.Literal(true) });

const LoopsKeyConflict = Schema.Struct({
  message: Schema.Literal("Idempotency key already used with a different request body."),
  success: Schema.Literal(false),
});

const parseLoopsAcknowledgement = Effect.fnUntraced(function* parseLoopsAcknowledgement(
  response: HttpClientResponse.HttpClientResponse,
  key: EmailIdempotencyKey | undefined,
): Effect.fn.Return<EmailReceipt, EmailSubmissionError> {
  if (response.status === 200) {
    const json = yield* readEmailHttpJson(response, "loops");
    yield* Schema.decodeUnknownEffect(LoopsAcknowledgement, { onExcessProperty: "error" })(
      json,
    ).pipe(
      Effect.mapError(
        () =>
          new EmailDeliveryUnknown({
            provider: "loops",
            reason: "invalid-response",
            status: response.status,
          }),
      ),
    );

    return Object.freeze(EmailReceiptSchema.cases.Accepted.make({ provider: "loops" }));
  }

  if (response.status === 409 && key !== undefined) {
    const json = yield* readEmailHttpJson(response, "loops");
    yield* Schema.decodeUnknownEffect(LoopsKeyConflict, { onExcessProperty: "error" })(json).pipe(
      Effect.mapError(
        () =>
          new EmailDeliveryUnknown({
            provider: "loops",
            reason: "invalid-response",
            status: response.status,
          }),
      ),
    );

    return yield* new EmailRejected({
      provider: "loops",
      reason: "idempotency-conflict",
      status: response.status,
    });
  }

  return yield* new EmailDeliveryUnknown({
    provider: "loops",
    reason: response.status >= 500 ? "server-error" : "unexpected-status",
    status: response.status,
  });
});

export const loopsTransactionalLayer = (
  options: LoopsTransactionalOptions,
  policy?: EmailDeliveryPolicy,
  observer?: EmailRetryObserver,
  restriction?: EmailRetryRestriction,
): Layer.Layer<LoopsTransactionalEmail, EmailConfigurationError, HttpClient.HttpClient> =>
  Layer.effect(
    LoopsTransactionalEmail,
    Effect.gen(function* acquireLoopsTransactionalEmail() {
      const configuration = yield* Schema.decodeEffect(LoopsConfiguration, {
        errors: "all",
        onExcessProperty: "error",
      })(options).pipe(
        Effect.mapError(
          (cause) => new EmailConfigurationError({ issues: emailInputIssues(cause) }),
        ),
      );

      const client = (yield* HttpClient.HttpClient).pipe(HttpClient.withScope);

      const idempotency = ownEmailSenderIdempotency(
        EmailSenderIdempotencySchema.cases.KeyForwarding.make({ maxKeyLength: 100 }),
      );

      const resolvedPolicy = yield* parseEmailReplayPolicy(idempotency, policy).pipe(
        Effect.mapError(
          (cause) => new EmailConfigurationError({ issues: emailInputIssues(cause) }),
        ),
      );

      const prepareParsed = Effect.fnUntraced(function* prepareParsedLoopsSubmission(
        parsed: LoopsTransactionalJob,
        parsedOptions: typeof EmailSendOptionsSchema.Type,
      ): Effect.fn.Return<
        PreparedLoopsSubmission,
        EmailInvalidMessage | EmailInvalidOptions | EmailRejected
      > {
        const job = ownLoopsJob(parsed);

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

        if (!supportsEmailIdempotencyKey(idempotency, parsedOptions.idempotencyKey)) {
          return yield* new EmailRejected({ provider: "loops", reason: "unsupported-idempotency" });
        }

        if (job.attachments !== undefined && configuration.attachments !== "AccountEnabled") {
          return yield* new EmailInvalidMessage({
            issues: [
              { path: "attachments", problem: "Loops attachment capability was not supplied" },
            ],
          });
        }

        const payload = JSON.stringify(buildLoopsPayload(job));

        if (new TextEncoder().encode(payload).byteLength >= 4_000_000) {
          return yield* new EmailInvalidMessage({
            issues: [
              {
                path: "attachments",
                problem: "Loops request must be smaller than the local UTF-8 JSON budget",
              },
            ],
          });
        }

        return Object.freeze({
          job,
          key: parsedOptions.idempotencyKey,
          payload,
          policy: effectivePolicy,
        });
      });

      const submit = Effect.fnUntraced(
        function* submitLoopsJob(
          payload: string,
          key: EmailIdempotencyKey | undefined,
        ): Effect.fn.Return<EmailReceipt, EmailSubmissionError, Scope.Scope> {
          let request = HttpClientRequest.post("https://app.loops.so/api/v1/transactional").pipe(
            HttpClientRequest.bearerToken(Redacted.value(configuration.apiKey)),
            HttpClientRequest.acceptJson,
            HttpClientRequest.bodyText(payload, "application/json"),
          );

          if (key !== undefined) {
            request = HttpClientRequest.setHeader(request, "Idempotency-Key", key);
          }

          const response = yield* client.execute(request).pipe(
            Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
            Effect.mapError(
              () => new EmailDeliveryUnknown({ provider: "loops", reason: "transport" }),
            ),
          );

          return yield* parseLoopsAcknowledgement(response, key);
        },
        Effect.scoped,
        emailOperationSpan("Loops.submit"),
      );

      const submitPrepared = (prepared: PreparedLoopsSubmission) =>
        submitEmailWithPolicy(
          submit(prepared.payload, prepared.key),
          { idempotency, provider: "loops" },
          prepared.key,
          prepared.policy,
          observer,
          restriction,
        );

      return LoopsTransactionalEmail.of({
        idempotency,
        ...emailNativeOperations({
          jobOf: (prepared: PreparedLoopsSubmission) => prepared.job,
          jobSchema: LoopsTransactionalJobSchema,
          prepare: prepareParsed,
          spans: { send: "Loops.send", sendAll: "Loops.sendAll", validate: "Loops.validate" },
          submit: submitPrepared,
        }),
      });
    }),
  );
