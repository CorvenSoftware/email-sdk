import { Context, Duration, Effect, Layer, Ref, Result } from "effect";
import { emailOperationSpan } from "./email-tracing.js";
import { EmailRejected } from "./email-rejected.js";
import { validateEmailCapabilities } from "./email-capabilities.js";
import { syntheticEmailCapabilities } from "./email-synthetic-capabilities.js";
import { EmailReceiptSchema } from "./email-message.js";
import type { EmailIdempotencyKey, EmailMessage, EmailReceipt } from "./email-message.js";
import { canonicalEmailMessageIdentity } from "./email-message-identity.js";
import { EmailSender, EmailSenderIdempotencySchema } from "./email-sender.js";
import type { EmailSubmission } from "./email-sender.js";
import { emailLayer } from "./email-service.js";

export const recordingEmailCapabilities = syntheticEmailCapabilities;

export interface IRecordedEmails {
  readonly messages: Effect.Effect<readonly EmailMessage[]>;
  readonly purgeMessages: Effect.Effect<number>;
}

export class RecordedEmails extends Context.Service<RecordedEmails, IRecordedEmails>()(
  "@corvencore/email-sdk/RecordedEmails",
) {}

interface RecordedReplay {
  readonly receipt: Extract<EmailReceipt, { readonly _tag: "Recorded" }>;
  readonly canonicalIdentity: string;
}

interface RecordingEmailState {
  readonly messages: readonly EmailMessage[];
  readonly sequence: number;
}

export const recordingSenderLayer = Layer.effectContext(
  Effect.gen(function* makeRecordingEmailSender() {
    const replays = new Map<EmailIdempotencyKey, RecordedReplay>();

    const records = yield* Ref.make<RecordingEmailState>({
      messages: [],
      sequence: 0,
    });

    const submit = Effect.fnUntraced(function* recordEmailSubmission(submission: EmailSubmission) {
      const canonicalIdentity =
        submission.idempotencyKey === undefined
          ? undefined
          : yield* canonicalEmailMessageIdentity(submission.message).pipe(Effect.orDie);

      const outcome = yield* Ref.modify(records, (current) => {
        const { message } = submission;

        const previous =
          submission.idempotencyKey === undefined
            ? undefined
            : replays.get(submission.idempotencyKey);

        if (previous !== undefined) {
          const duplicate =
            previous.canonicalIdentity === canonicalIdentity
              ? Result.succeed(previous.receipt)
              : Result.fail(
                  new EmailRejected({
                    provider: "recording",
                    reason: "idempotency-conflict",
                    status: 409,
                  }),
                );

          return [duplicate, current] as const;
        }

        const receipt = Object.freeze(
          EmailReceiptSchema.cases.Recorded.make({ sequence: current.sequence + 1 }),
        );

        if (submission.idempotencyKey !== undefined && canonicalIdentity !== undefined) {
          replays.set(submission.idempotencyKey, { canonicalIdentity, receipt });
        }

        return [
          Result.succeed(receipt),
          {
            messages: [...current.messages, message],
            sequence: receipt.sequence,
          },
        ] as const;
      });

      return yield* Effect.fromResult(outcome);
    }, emailOperationSpan("RecordingEmailSender.submit"));

    const messages = Ref.get(records).pipe(
      Effect.map((current) => [...current.messages]),
      emailOperationSpan("RecordedEmails.messages"),
    );

    const purgeMessages = Ref.modify(records, (current) => [
      current.messages.length,
      { ...current, messages: [] },
    ]).pipe(emailOperationSpan("RecordedEmails.purgeMessages"));

    return Context.make(
      EmailSender,
      EmailSender.of({
        capabilities: recordingEmailCapabilities,
        idempotency: EmailSenderIdempotencySchema.cases.Native.make({
          retention: Duration.infinity,
        }),
        provider: "recording",
        submit,
        validate: (message) => validateEmailCapabilities(message, recordingEmailCapabilities),
      }),
    ).pipe(Context.add(RecordedEmails, RecordedEmails.of({ messages, purgeMessages })));
  }),
);

export const recordingEmailLayer = emailLayer().pipe(Layer.provideMerge(recordingSenderLayer));
