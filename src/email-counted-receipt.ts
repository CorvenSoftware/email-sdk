import { Effect, Schema } from "effect";
import { EmailAddressSchema } from "./email-address.js";
import { EmailDeliveryUnknown } from "./email-delivery-unknown.js";
import { EmailReceiptSchema, ownEmailReceipt } from "./email-message.js";
import type { EmailMessage, EmailMessageId, EmailReceipt } from "./email-message.js";
import { emailRecipientAddresses, parseEmailRecipientCounts } from "./email-recipient-outcomes.js";
import type { EmailRecipientCounts } from "./email-recipient-outcomes.js";

export const parseEmailCountedReceipt = Effect.fnUntraced(function* parseEmailCountedReceipt(
  message: EmailMessage,
  input: EmailRecipientCounts,
  provider: string,
  status: number,
  messageId: EmailMessageId,
): Effect.fn.Return<EmailReceipt, EmailDeliveryUnknown> {
  const counts = yield* parseEmailRecipientCounts(message, input, provider, status);

  if (counts.acceptedCount === 0) {
    const rejected = yield* Schema.decodeUnknownEffect(Schema.NonEmptyArray(EmailAddressSchema))(
      emailRecipientAddresses(message),
    ).pipe(
      Effect.mapError(
        () => new EmailDeliveryUnknown({ provider, reason: "invalid-response", status }),
      ),
    );

    const receipt = EmailReceiptSchema.cases.RecipientsRejected.make({
      messageId,
      provider,
      rejected,
    });

    return ownEmailReceipt(receipt);
  }

  if (counts.rejectedCount > 0) {
    const receipt = EmailReceiptSchema.cases.PartiallyAcceptedCounts.make({
      counts,
      messageId,
      provider,
    });

    return ownEmailReceipt(receipt);
  }

  return ownEmailReceipt(EmailReceiptSchema.cases.Accepted.make({ messageId, provider }));
});
