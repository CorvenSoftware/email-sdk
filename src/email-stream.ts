import { Effect, Stream } from "effect";
import type { Result } from "effect";
import type { EmailSendError } from "./email-errors.js";
import type { EmailInvalidOptions } from "./email-invalid-options.js";
import type { EmailReceipt } from "./email-message.js";
import {
  parseEmailBatchOptions,
  prepareEmailSendRequest,
  preparedEmailSendOptions,
  qualifyEmailRequestFailure,
} from "./email-preparation.js";
import type { EmailBatchOptionsInput, EmailSendRequest } from "./email-preparation.js";
import { Email } from "./email-service.js";
import { protectEmailUnsettledCause } from "./email-unsettled-cause.js";

export interface EmailStreamOutcome {
  readonly index: number;
  readonly result: Result.Result<EmailReceipt, EmailSendError>;
}

export const sendEmailStream = <E, R>(
  source: Stream.Stream<EmailSendRequest, E, R>,
  options?: EmailBatchOptionsInput,
): Stream.Stream<EmailStreamOutcome, E | EmailInvalidOptions, R | Email> =>
  Stream.unwrap(
    Effect.gen(function* configureEmailStream() {
      const parsedOptions = yield* parseEmailBatchOptions(options);
      const email = yield* Email;

      return source.pipe(
        Stream.mapEffect((request, index) =>
          prepareEmailSendRequest(request).pipe(
            Effect.flatMap((submission) =>
              qualifyEmailRequestFailure(
                email.prepare(submission.submission.message, preparedEmailSendOptions(submission)),
              ),
            ),
            protectEmailUnsettledCause,
            Effect.result,
            Effect.map((prepared) => ({ index, prepared })),
          ),
        ),
        Stream.mapEffect(
          ({ index, prepared }) =>
            Effect.fromResult(prepared).pipe(
              Effect.flatMap((operation) => operation.send),
              protectEmailUnsettledCause,
              Effect.result,
              Effect.map((result): EmailStreamOutcome => ({ index, result })),
            ),
          { concurrency: parsedOptions.concurrency },
        ),
      );
    }),
  );
