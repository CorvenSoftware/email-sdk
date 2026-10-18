import { Effect } from "effect";
import type { DateTime, Redacted } from "effect";
import { Email, EmailReceiptSchema } from "../src/index.js";
import { mailchimpEmailLayer } from "../src/mailchimp-email-sender.js";
import type { MailchimpTagStatisticsInput } from "../src/mailchimp-email-sender.js";

export const mailchimpNotificationLayer = (
  apiKey: Redacted.Redacted,
  tagStatistics?: MailchimpTagStatisticsInput,
) => {
  const options = {
    apiKey,
    automaticFooter: "AccountDisabled",
    keyMode: "Live",
    messageRules: "AccountDisabled",
  } as const;

  return mailchimpEmailLayer(tagStatistics === undefined ? options : { ...options, tagStatistics });
};

export const mailchimpNotification = Effect.gen(function* submitMailchimpNotification() {
  const receipt = yield* (yield* Email).send({
    body: { text: "This is a fictional Mailchimp Transactional example." },
    from: "sender@example.test",
    subject: "Synthetic notification",
    to: ["first@example.test", "second@example.test"],
  });

  return EmailReceiptSchema.guards.RecipientOutcomes(receipt) ? receipt.outcomes : undefined;
});

export const mailchimpScheduledNotification = Effect.fnUntraced(
  function* submitScheduledMailchimpNotification(sendAt: DateTime.Utc) {
    return yield* (yield* Email).send({
      body: { text: "This is a fictional scheduled Mailchimp Transactional example." },
      from: "sender@example.test",
      sendAt,
      subject: "Synthetic scheduled notification",
      to: "recipient@example.test",
    });
  },
);
