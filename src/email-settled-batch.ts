import { Effect } from "effect";
import { protectEmailUnsettledCause } from "./email-unsettled-cause.js";
import type { Result } from "effect";
import type { EmailSendError } from "./email-errors.js";
import type { EmailReceipt } from "./email-message.js";

export const submitPreparedEmailBatch = <Submission, Receipt extends EmailReceipt>(
  prepared: readonly Result.Result<Submission, EmailSendError>[],
  concurrency: number,
  submit: (submission: Submission) => Effect.Effect<Receipt, EmailSendError>,
): Effect.Effect<readonly Result.Result<Receipt, EmailSendError>[]> =>
  Effect.forEach(
    prepared,
    (item) =>
      Effect.fromResult(item).pipe(
        Effect.flatMap(submit),
        protectEmailUnsettledCause,
        Effect.result,
      ),
    { concurrency },
  );
