import { Effect, Layer, Result, Schema, Struct } from "effect";
import type { Scope } from "effect";
import { HttpClient } from "effect/http";
import type { HttpClientRequest, HttpClientResponse } from "effect/http";
import { EmailConfigurationError } from "./email-configuration-error.js";
import { EmailDeliveryUnknown } from "./email-delivery-unknown.js";
import type { EmailSubmissionError } from "./email-errors.js";
import { emailInputIssues } from "./email-input-issues.js";
import type { EmailInvalidMessage } from "./email-invalid-message.js";
import { EmailReceiptSchema } from "./email-message.js";
import type { EmailMessage, EmailReceipt } from "./email-message.js";
import type { EmailDeliveryPolicy } from "./email-delivery-policy.js";
import { prepareEmailPersonalization } from "./email-personalization.js";
import { parseEmailPersonalizedOptions, preparedEmailSendOptions } from "./email-preparation.js";
import type { EmailPreflight } from "./email-preflight.js";
import type { EmailRetryObserver, EmailRetryRestriction } from "./email-retry-decision.js";
import {
  EmailSender,
  supportsEmailIdempotencyKey,
  ownEmailSenderIdempotency,
} from "./email-sender.js";
import type { IEmail } from "./email-service.js";
import { submitEmailWithPolicy } from "./email-submission-policy.js";
import { protectEmailUnsettledCause } from "./email-unsettled-cause.js";
import { EmailRejected } from "./email-rejected.js";
import type {
  EmailSenderIdempotencySchema,
  EmailSubmission,
  IEmailSender,
} from "./email-sender.js";
import { emailOperationSpan } from "./email-tracing.js";

const executeEmailHttpRequest = <E, R>(
  client: HttpClient.HttpClient.With<E, R>,
  request: HttpClientRequest.HttpClientRequest,
  provider: string,
): Effect.Effect<HttpClientResponse.HttpClientResponse, EmailDeliveryUnknown, R> =>
  client.execute(request).pipe(
    Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
    protectEmailUnsettledCause,
    Effect.mapError(() => new EmailDeliveryUnknown({ provider, reason: "transport" })),
  );

export interface EmailHttpExchange {
  readonly request: (
    submission: EmailSubmission,
  ) => Effect.Effect<HttpClientRequest.HttpClientRequest, EmailRejected>;
  readonly respond: (
    response: HttpClientResponse.HttpClientResponse,
    message: EmailMessage,
  ) => Effect.Effect<EmailReceipt, EmailSubmissionError>;
}

export interface EmailHttpProtocol extends EmailPreflight, EmailHttpExchange {
  readonly span: string;
}

const makeEmailHttpSender = Effect.fnUntraced(function* acquireEmailHttpProtocol(
  protocol: EmailHttpProtocol,
): Effect.fn.Return<IEmailSender, never, HttpClient.HttpClient> {
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.withScope);
  const idempotency = ownEmailSenderIdempotency(protocol.idempotency);

  const submit = Effect.fnUntraced(
    function* submitEmailHttpProtocol(
      submission: EmailSubmission,
    ): Effect.fn.Return<EmailReceipt, EmailSubmissionError, Scope.Scope> {
      if (!supportsEmailIdempotencyKey(idempotency, submission.idempotencyKey)) {
        return yield* new EmailRejected({
          provider: protocol.provider,
          reason: "unsupported-idempotency",
        });
      }

      yield* protocol
        .validate(submission.message)
        .pipe(
          Effect.mapError(
            () => new EmailRejected({ provider: protocol.provider, reason: "invalid-message" }),
          ),
        );
      const request = yield* protocol.request(submission);
      const response = yield* executeEmailHttpRequest(client, request, protocol.provider);

      return yield* protocol.respond(response, submission.message);
    },
    Effect.scoped,
    emailOperationSpan(protocol.span),
  );

  return EmailSender.of({
    capabilities: protocol.capabilities,
    idempotency,
    provider: protocol.provider,
    submit,
    validate: protocol.validate,
  });
});

export const emailHttpProtocolLayer = <E, R>(
  protocol: Effect.Effect<EmailHttpProtocol, E, R>,
): Layer.Layer<EmailSender, E, HttpClient.HttpClient | Exclude<R, Scope.Scope>> =>
  Layer.effect(EmailSender, protocol.pipe(Effect.flatMap(makeEmailHttpSender)));

export const emailHttpSenderLayer = <Configuration, Encoded>(
  schema: Schema.Codec<Configuration, Encoded>,
  options: Configuration,
  protocolFor: (configuration: Configuration) => EmailHttpProtocol,
): Layer.Layer<EmailSender, EmailConfigurationError, HttpClient.HttpClient> =>
  emailHttpProtocolLayer(
    Effect.gen(function* acquireEmailHttpSender() {
      const configuration = yield* Schema.decodeEffect(Schema.toType(schema), {
        errors: "all",
        onExcessProperty: "error",
      })(options).pipe(
        Effect.mapError(
          (cause) => new EmailConfigurationError({ issues: emailInputIssues(cause) }),
        ),
      );

      return protocolFor(configuration);
    }),
  );

const EmailHttpSubmissionCorrelation = Schema.Struct({
  submissionId: EmailReceiptSchema.cases.Accepted.fields.submissionId,
});

export interface EmailHttpPersonalizationProtocol {
  readonly idempotency: typeof EmailSenderIdempotencySchema.cases.None.Type;
  readonly provider: string;
  readonly spans: { readonly send: string; readonly submit: string };
  readonly validate: EmailHttpProtocol["validate"];
  readonly validateItem: (message: EmailMessage) => Effect.Effect<void, EmailInvalidMessage>;
  readonly request: (
    messages: readonly [EmailMessage, ...EmailMessage[]],
  ) => Effect.Effect<HttpClientRequest.HttpClientRequest, EmailInvalidMessage | EmailRejected>;
  readonly respond: (
    response: HttpClientResponse.HttpClientResponse,
  ) => Effect.Effect<typeof EmailReceiptSchema.cases.Accepted.Type, EmailSubmissionError>;
}

export const emailHttpPersonalization = (
  email: IEmail,
  protocol: EmailHttpPersonalizationProtocol,
  httpClient: HttpClient.HttpClient,
  policy: EmailDeliveryPolicy,
  observer?: EmailRetryObserver,
  restriction?: EmailRetryRestriction,
): IEmail["sendPersonalized"] => {
  const client = httpClient.pipe(HttpClient.withScope);

  return Effect.fnUntraced(function* sendNativePersonalizedAudience(input, batchOptions) {
    const options = yield* parseEmailPersonalizedOptions(batchOptions);

    const expanded = yield* prepareEmailPersonalization(input, options.executionMetadata);

    const prepared = yield* Effect.forEach(
      expanded,
      (item) =>
        Effect.fromResult(item).pipe(
          Effect.flatMap((entry) =>
            email.validate(entry.submission.message, preparedEmailSendOptions(entry)),
          ),
          Effect.tap(protocol.validateItem),
          protectEmailUnsettledCause,
          Effect.result,
        ),
      { concurrency: 1 },
    );

    const [first, ...remaining] = prepared.filter(Result.isSuccess).map((item) => item.success);

    if (first === undefined) {
      return prepared.filter(Result.isFailure).map((item) => Result.fail(item.failure));
    }

    const messages: readonly [EmailMessage, ...EmailMessage[]] = Object.freeze([
      first,
      ...remaining,
    ]);

    const outcome = yield* Effect.gen(function* submitNativePersonalizedAudience() {
      const request = yield* protocol.request(messages);

      const submit = Effect.fnUntraced(
        function* submitNativePersonalizedRequest() {
          yield* Effect.forEach(messages, protocol.validate, {
            concurrency: 1,
            discard: true,
          }).pipe(
            Effect.mapError(
              () => new EmailRejected({ provider: protocol.provider, reason: "invalid-message" }),
            ),
          );

          const response = yield* executeEmailHttpRequest(client, request, protocol.provider);

          const acknowledgement = yield* protocol.respond(response);

          const correlation = yield* Schema.decodeEffect(EmailHttpSubmissionCorrelation)(
            Struct.renameKeys(Struct.pick(acknowledgement, ["messageId"]), {
              messageId: "submissionId",
            }),
          ).pipe(
            Effect.mapError(
              () =>
                new EmailDeliveryUnknown({
                  provider: protocol.provider,
                  reason: "invalid-response",
                  status: response.status,
                }),
            ),
          );

          return Object.freeze(
            EmailReceiptSchema.cases.Accepted.make({ ...correlation, provider: protocol.provider }),
          );
        },
        Effect.scoped,
        emailOperationSpan(protocol.spans.submit),
      );

      return yield* submitEmailWithPolicy(
        submit(),
        {
          idempotency: protocol.idempotency,
          provider: protocol.provider,
        },
        undefined,
        policy,
        observer,
        restriction,
      );
    }).pipe(protectEmailUnsettledCause, Effect.result);

    return prepared.map((item) =>
      Result.match(item, {
        onFailure: (failure) => Result.fail(failure),
        onSuccess: () => outcome,
      }),
    );
  }, emailOperationSpan(protocol.spans.send));
};
