import { Effect, Schema } from "effect";
import { EmailDeliveryUnknown } from "./email-delivery-unknown.js";
import { EmailReceiptSchema } from "./email-message.js";
import type {
  EmailMessage,
  EmailMessageId,
  EmailReceipt,
  EmailRecipientOutcome,
} from "./email-message.js";
import {
  emailRecipientAddresses,
  parseEmailRecipientCoverage,
} from "./email-recipient-outcomes.js";

export const parseEmailRecipientReceipt = Effect.fnUntraced(function* parseEmailRecipientReceipt(
  message: EmailMessage,
  outcomes: readonly EmailRecipientOutcome[],
  provider: string,
  status: number,
  messageId?: EmailMessageId,
): Effect.fn.Return<EmailReceipt, EmailDeliveryUnknown> {
  const invalid = () => new EmailDeliveryUnknown({ provider, reason: "invalid-response", status });
  yield* parseEmailRecipientCoverage(
    message,
    outcomes.map(({ recipient }) => recipient),
    provider,
    status,
  );

  const ordered = yield* Effect.forEach(
    emailRecipientAddresses(message),
    Effect.fnUntraced(function* ownEmailRecipientOutcome(recipient) {
      const outcome = outcomes.find(
        (candidate) => candidate.recipient.toLowerCase() === recipient.toLowerCase(),
      );

      if (outcome === undefined) {
        return yield* invalid();
      }

      return { ...outcome, recipient };
    }),
  );

  const owned = yield* Schema.decodeUnknownEffect(
    EmailReceiptSchema.cases.RecipientOutcomes.fields.outcomes,
  )(ordered).pipe(Effect.mapError(invalid));

  const receipt =
    messageId === undefined
      ? EmailReceiptSchema.cases.RecipientOutcomes.make({ outcomes: owned, provider })
      : EmailReceiptSchema.cases.RecipientOutcomes.make({ messageId, outcomes: owned, provider });

  for (const outcome of receipt.outcomes) {
    Object.freeze(outcome);
  }

  Object.freeze(receipt.outcomes);

  return Object.freeze(receipt);
});
