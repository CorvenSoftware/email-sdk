import { Context, DateTime, Duration, Effect, Layer, Ref, Result } from "effect";
import { emailOperationSpan } from "./email-tracing.js";
import { EmailRejected } from "./email-rejected.js";
import { validateEmailCapabilities } from "./email-capabilities.js";
import { syntheticEmailCapabilities } from "./email-synthetic-capabilities.js";
import { EmailReceiptSchema } from "./email-message.js";
import type { EmailIdempotencyKey, EmailMessage, EmailReceipt } from "./email-message.js";
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
  readonly fingerprint: string;
}

interface RecordingEmailState {
  readonly messages: readonly EmailMessage[];
  readonly replays: ReadonlyMap<EmailIdempotencyKey, RecordedReplay>;
  readonly sequence: number;
}

export const recordingSenderLayer = Layer.effectContext(
  Effect.gen(function* makeRecordingEmailSender() {
    const records = yield* Ref.make<RecordingEmailState>({
      messages: [],
      replays: new Map(),
      sequence: 0,
    });

    const submit = Effect.fnUntraced(function* recordEmailSubmission(submission: EmailSubmission) {
      const outcome = yield* Ref.modify(records, (current) => {
        const { message } = submission;

        const fingerprint = JSON.stringify({
          attachments: message.attachments?.map((attachment) => ({
            contentBase64: attachment.contentBase64,
            contentId: attachment.contentId,
            contentType: attachment.contentType,
            disposition: attachment.disposition,
            filename: attachment.filename,
          })),
          bcc: message.bcc,
          cc: message.cc,
          from: message.from,
          headers: message.headers,
          html: message.body.html,
          metadata: message.metadata,
          replyTo: message.replyTo,
          sendAt: message.sendAt === undefined ? undefined : DateTime.formatIso(message.sendAt),
          subject: message.subject,
          tags: message.tags,
          text: message.body.text,
          to: message.to,
        });

        const previous =
          submission.idempotencyKey === undefined
            ? undefined
            : current.replays.get(submission.idempotencyKey);

        if (previous !== undefined) {
          const duplicate =
            previous.fingerprint === fingerprint
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

        const replays =
          submission.idempotencyKey === undefined
            ? current.replays
            : new Map(current.replays).set(submission.idempotencyKey, { fingerprint, receipt });

        return [
          Result.succeed(receipt),
          {
            messages: [...current.messages, message],
            replays,
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
