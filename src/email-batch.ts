import { Effect } from "effect";
import { protectEmailUnsettledCause } from "./email-unsettled-cause.js";
import { emailOperationSpan } from "./email-tracing.js";
import { submitPreparedEmailBatch } from "./email-settled-batch.js";
import type { EmailSendError } from "./email-errors.js";
import type { EmailReceipt } from "./email-message.js";
import { prepareEmailPersonalization } from "./email-personalization.js";
import type { EmailPersonalizedInput } from "./email-personalization.js";
import {
  parseEmailBatchOptions,
  parseEmailPersonalizedOptions,
  prepareEmailSendRequest,
  qualifyEmailRequestFailure,
} from "./email-preparation.js";
import type {
  EmailBatchOptionsInput,
  EmailPersonalizedOptionsInput,
  EmailSendRequest,
  PreparedEmailSubmission,
} from "./email-preparation.js";

export const emailBatchOperations = <Prepared, Receipt extends EmailReceipt>(
  preflight: (prepared: PreparedEmailSubmission) => Effect.Effect<Prepared, EmailSendError>,
  submit: (prepared: Prepared) => Effect.Effect<Receipt, EmailSendError>,
) => {
  const sendAll = Effect.fnUntraced(function* sendAllEmails(
    requests: readonly EmailSendRequest[],
    options?: EmailBatchOptionsInput,
  ) {
    const parsedOptions = yield* parseEmailBatchOptions(options);

    const prepared = yield* Effect.forEach(
      requests,
      (request) =>
        prepareEmailSendRequest(request).pipe(
          Effect.flatMap((submission) => qualifyEmailRequestFailure(preflight(submission))),
          protectEmailUnsettledCause,
          Effect.result,
        ),
      { concurrency: 1 },
    );

    return yield* submitPreparedEmailBatch(prepared, parsedOptions.concurrency, submit);
  }, emailOperationSpan("Email.sendAll"));

  const sendPersonalized = Effect.fnUntraced(function* sendPersonalizedEmails(
    input: EmailPersonalizedInput,
    options?: EmailPersonalizedOptionsInput,
  ) {
    const parsedOptions = yield* parseEmailPersonalizedOptions(options);
    const expanded = yield* prepareEmailPersonalization(input, parsedOptions.executionMetadata);

    const prepared = yield* Effect.forEach(
      expanded,
      (item) =>
        Effect.fromResult(item).pipe(
          Effect.flatMap(preflight),
          protectEmailUnsettledCause,
          Effect.result,
        ),
      { concurrency: 1 },
    );

    return yield* submitPreparedEmailBatch(prepared, parsedOptions.concurrency, submit);
  }, emailOperationSpan("Email.sendPersonalized"));

  return { sendAll, sendPersonalized };
};
