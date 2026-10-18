import { Effect, Schema } from "effect";
import type { EmailAddress } from "./email-address.js";
import { EmailDeliveryUnknown } from "./email-delivery-unknown.js";
import { EmailReceiptSchema, ownEmailReceipt } from "./email-message.js";
import type { EmailMessageId, EmailReceipt } from "./email-message.js";

export const parseEmailPartialSuppressionReceipt = Effect.fnUntraced(
  function* parseEmailPartialSuppressionReceipt(
    partition: {
      readonly accepted: readonly EmailAddress[];
      readonly suppressed: readonly EmailAddress[];
    },
    provider: string,
    status: number,
    messageId?: EmailMessageId,
  ): Effect.fn.Return<EmailReceipt, EmailDeliveryUnknown> {
    const owned = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        accepted: EmailReceiptSchema.cases.PartiallyAccepted.fields.accepted,
        suppressed: EmailReceiptSchema.cases.PartiallyAccepted.fields.suppressed,
      }),
    )(partition).pipe(
      Effect.mapError(
        () => new EmailDeliveryUnknown({ provider, reason: "invalid-response", status }),
      ),
    );

    const receipt =
      messageId === undefined
        ? EmailReceiptSchema.cases.PartiallyAccepted.make({ ...owned, provider })
        : EmailReceiptSchema.cases.PartiallyAccepted.make({ ...owned, messageId, provider });

    return ownEmailReceipt(receipt);
  },
);
