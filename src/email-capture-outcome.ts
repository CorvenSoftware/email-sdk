import { Effect, Exit, Match, Option, Schema } from "effect";
import type { SchemaIssue } from "effect";
import { EmailCaptureOutcomeSchema } from "./email-capture-retention.js";
import type { EmailSendError } from "./email-errors.js";
import type { EmailReceipt } from "./email-message.js";

const captureEmailOutcome = Effect.fnUntraced(function* captureEmailOutcome(
  exit: Exit.Exit<EmailReceipt, EmailSendError>,
): Effect.fn.Return<Option.Option<typeof EmailCaptureOutcomeSchema.Type>, SchemaIssue.Issue> {
  if (Exit.isSuccess(exit)) {
    return Option.some(
      yield* EmailCaptureOutcomeSchema.cases.Receipt.makeEffect({ receipt: exit.value }),
    );
  }

  const aborted = EmailCaptureOutcomeSchema.cases.Aborted.make({
    defect: Exit.hasDies(exit),
    interrupted: Exit.hasInterrupts(exit),
  });

  if (aborted.defect || aborted.interrupted) {
    return Option.some(aborted);
  }

  return yield* Option.match(Exit.findErrorOption(exit), {
    onNone: () => Effect.succeedSome(aborted),
    onSome: (failure) =>
      Match.value(failure).pipe(
        Match.tag("EmailInvalidMessage", "EmailInvalidOptions", () => Effect.succeedNone),
        Match.tag("EmailRejected", (rejected) =>
          EmailCaptureOutcomeSchema.cases.Rejected.makeEffect({ failure: rejected }).pipe(
            Effect.asSome,
          ),
        ),
        Match.tag("EmailDeliveryUnknown", (unknown) =>
          EmailCaptureOutcomeSchema.cases.Unknown.makeEffect({ failure: unknown }).pipe(
            Effect.asSome,
          ),
        ),
        Match.exhaustive,
      ),
  });
});

const encodeCapturedOutcome = Schema.encodeEffect(Schema.fromJsonString(EmailCaptureOutcomeSchema));

export const encodeEmailCaptureOutcome = Effect.fnUntraced(function* encodeEmailCaptureOutcome(
  exit: Exit.Exit<EmailReceipt, EmailSendError>,
) {
  const outcome = yield* captureEmailOutcome(exit);

  if (Option.isNone(outcome)) {
    return Option.none();
  }

  return Option.some(yield* encodeCapturedOutcome(outcome.value));
});
