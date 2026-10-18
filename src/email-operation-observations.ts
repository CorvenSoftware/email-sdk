import { Effect, Layer, Match, Result, Schema, Struct } from "effect";
import type { Scope } from "effect";
import { acquireEmailExtension } from "./email-extension.js";
import type { EmailExtension } from "./email-extension.js";
import { requireIndividualEmailPreparation } from "./email-composition.js";
import type { EmailConfigurationError } from "./email-configuration-error.js";
import { EmailDeliveryUnknown } from "./email-delivery-unknown.js";
import type { EmailSendError } from "./email-errors.js";
import { EmailInvalidMessage } from "./email-invalid-message.js";
import { EmailInvalidOptions } from "./email-invalid-options.js";
import { EmailReceiptSchema, ownEmailReceipt } from "./email-message.js";
import type { EmailReceipt } from "./email-message.js";
import {
  emailPreparedOperations,
  ownEmailPreparedPreviews,
  preparedEmailOperation,
} from "./email-prepared-operation.js";
import type { EmailPreparedOperation } from "./email-prepared-operation.js";
import { preparedEmailSendOptions } from "./email-preparation.js";
import type { PreparedEmailSubmission } from "./email-preparation.js";
import { EmailRejected } from "./email-rejected.js";
import { EmailRouteNameSchema, EmailRoutedReceiptSchema } from "./email-routing.js";
import { Email } from "./email-service.js";
import { emailOperationSpan } from "./email-tracing.js";
import { protectEmailUnsettledCause } from "./email-unsettled-cause.js";

export class EmailOperationObservationError extends Schema.TaggedError<EmailOperationObservationError>()(
  "EmailOperationObservationError",
  { reason: Schema.Literal("invalid-outcome") },
) {}

export const EmailOperationOutcomeSchema = Schema.TaggedUnion({
  Failure: {
    failure: Schema.Union([
      EmailInvalidMessage,
      EmailInvalidOptions,
      EmailRejected,
      EmailDeliveryUnknown,
    ]),
  },
  Receipt: { receipt: EmailReceiptSchema, route: Schema.optionalKey(EmailRouteNameSchema) },
});

export type EmailOperationOutcome = typeof EmailOperationOutcomeSchema.Type;

export interface EmailOperationEvent {
  readonly previews: EmailPreparedOperation["previews"];
  readonly outcome: EmailOperationOutcome;
}

export type EmailOperationObserver = (event: EmailOperationEvent) => Effect.Effect<void>;

const parseReceipt = Schema.decodeUnknownEffect(
  Schema.toType(Schema.Union([EmailRoutedReceiptSchema, EmailReceiptSchema])),
  {
    errors: "all",
    onExcessProperty: "error",
  },
);

const parseBaseReceipt = Schema.decodeEffect(Schema.toType(EmailReceiptSchema), {
  onExcessProperty: "ignore",
});

const parseRoute = Schema.decodeUnknownEffect(
  Schema.Struct({ route: Schema.optionalKey(EmailRouteNameSchema) }),
);

const failureFields = ["provider", "providerCode", "reason", "retryAfterMillis", "status"] as const;

const freezeOperationIssues = <Failure extends EmailInvalidMessage | EmailInvalidOptions>(
  failure: Failure,
): Failure => {
  for (const issue of failure.issues) {
    Object.freeze(issue);
  }

  Object.freeze(failure.issues);

  return Object.freeze(failure);
};

const ownOperationFailure = (failure: EmailSendError): EmailSendError =>
  Match.value(failure).pipe(
    Match.tag("EmailInvalidMessage", (invalid) =>
      freezeOperationIssues(new EmailInvalidMessage({ issues: invalid.issues })),
    ),
    Match.tag("EmailInvalidOptions", (invalid) =>
      freezeOperationIssues(new EmailInvalidOptions({ issues: invalid.issues })),
    ),
    Match.tag("EmailRejected", (rejected) =>
      Object.freeze(new EmailRejected(Struct.pick(rejected, failureFields))),
    ),
    Match.tag("EmailDeliveryUnknown", (unknown) =>
      Object.freeze(new EmailDeliveryUnknown(Struct.pick(unknown, failureFields))),
    ),
    Match.exhaustive,
  );

const operationOutcome = Effect.fnUntraced(function* operationOutcome(
  result: Result.Result<EmailReceipt, EmailSendError>,
): Effect.fn.Return<EmailOperationOutcome> {
  return yield* Result.match(result, {
    onFailure: (failure) =>
      Effect.succeed(
        Object.freeze(
          Struct.evolve(EmailOperationOutcomeSchema.cases.Failure.make({ failure }), {
            failure: ownOperationFailure,
          }),
        ),
      ),
    onSuccess: (receipt) =>
      Effect.gen(function* ownOperationReceiptOutcome() {
        const parsed = yield* parseReceipt(receipt);
        const route = yield* parseRoute(parsed);
        const base = yield* parseBaseReceipt(parsed);

        return Object.freeze(
          Struct.evolve(
            EmailOperationOutcomeSchema.cases.Receipt.make({ ...route, receipt: base }),
            { receipt: ownEmailReceipt },
          ),
        );
      }).pipe(
        Effect.mapError(() => new EmailOperationObservationError({ reason: "invalid-outcome" })),
        Effect.orDie,
      ),
  });
});

export const observedEmailOperationLayer = <E, R, E2 = never, R2 = never>(
  emailLayer: Layer.Layer<Email, E, R>,
  observer: EmailExtension<EmailOperationObserver, E2, R2>,
): Layer.Layer<
  Email,
  E | E2 | EmailConfigurationError,
  R | Exclude<Exclude<R2, Scope.Scope>, Email>
> =>
  Layer.effect(
    Email,
    Effect.gen(function* acquireObservedEmailOperations() {
      const email = yield* Email;
      yield* requireIndividualEmailPreparation(email.personalization);
      const observe = yield* acquireEmailExtension(observer);

      const prepare = Effect.fnUntraced(function* prepareObservedEmailOperation(
        prepared: PreparedEmailSubmission,
      ) {
        const operation = yield* email.prepare(
          prepared.submission.message,
          preparedEmailSendOptions(prepared),
        );

        const previews = ownEmailPreparedPreviews(operation.previews);

        const send = Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* settleObservedEmailOperation() {
            const result = yield* restore(operation.send).pipe(
              protectEmailUnsettledCause,
              Effect.result,
            );

            return yield* Effect.fromResult(result).pipe(
              Effect.onExit(() =>
                Effect.gen(function* notifyEmailOperationOutcome() {
                  const outcome = yield* operationOutcome(result);
                  const event = Object.freeze({ outcome, previews });
                  yield* restore(Effect.suspend(() => observe(event)).pipe(Effect.orDie));
                }).pipe(emailOperationSpan("EmailOperation.observe")),
              ),
            );
          }),
        ).pipe(protectEmailUnsettledCause);

        return preparedEmailOperation(previews, operation.validate, send);
      });

      return Email.of({ capabilities: email.capabilities, ...emailPreparedOperations(prepare) });
    }),
  ).pipe(Layer.provide(emailLayer));
