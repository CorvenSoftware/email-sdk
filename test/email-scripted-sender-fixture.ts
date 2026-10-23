import { Effect, Layer, Queue, Ref } from "effect";
import { validateEmailCapabilities } from "../src/email-capabilities.js";
import type { EmailSubmissionError } from "../src/email-errors.js";
import { ownEmailMessage } from "../src/email-message.js";
import type { EmailReceipt } from "../src/email-message.js";
import { EmailSender, EmailSenderIdempotencySchema } from "../src/email-sender.js";
import type { EmailSenderIdempotency, EmailSubmission } from "../src/email-sender.js";
import { syntheticEmailCapabilities } from "../src/email-synthetic-capabilities.js";

export type ScriptedEmailOutcome = Effect.Effect<EmailReceipt, EmailSubmissionError>;

export interface ScriptedEmailSenderOptions {
  readonly provider?: string;
  readonly idempotency?: EmailSenderIdempotency;
}

export interface ScriptedEmailSenderFixture {
  readonly layer: Layer.Layer<EmailSender>;
  readonly attempts: Effect.Effect<readonly EmailSubmission[]>;
  readonly submissions: Queue.Dequeue<EmailSubmission>;
}

export const makeScriptedEmailSender = Effect.fnUntraced(function* makeScriptedEmailSender(
  outcomes: readonly ScriptedEmailOutcome[],
  options: ScriptedEmailSenderOptions = {},
): Effect.fn.Return<ScriptedEmailSenderFixture> {
  const script = Object.freeze([...outcomes]);
  const attempts = yield* Ref.make<readonly EmailSubmission[]>(Object.freeze([]));
  const submissions = yield* Queue.unbounded<EmailSubmission>();

  const submit = Effect.fnUntraced(function* submitScriptedEmail(
    submission: EmailSubmission,
  ): Effect.fn.Return<EmailReceipt, EmailSubmissionError> {
    const owned = Object.freeze({
      ...submission,
      message: ownEmailMessage(submission.message),
    });

    const outcome = yield* Ref.modify(attempts, (current) => [
      script[current.length],
      Object.freeze([...current, owned]),
    ]);

    yield* Queue.offer(submissions, owned);

    if (outcome === undefined) {
      return yield* Effect.die(new Error("ScriptedEmailSender exhausted its outcome sequence"));
    }

    return yield* outcome;
  });

  const sender = EmailSender.of({
    capabilities: syntheticEmailCapabilities,
    idempotency: options.idempotency ?? EmailSenderIdempotencySchema.cases.None.make({}),
    provider: options.provider ?? "scripted",
    submit,
    validate: (message) => validateEmailCapabilities(message, syntheticEmailCapabilities),
  });

  return {
    attempts: Ref.get(attempts),
    layer: Layer.succeed(EmailSender, sender),
    submissions,
  };
});
