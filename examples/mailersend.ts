import type { Redacted } from "effect";
import { DateTime, Effect } from "effect";
import { Email, emailAttachmentFromBytes } from "../src/index.js";
import { mailersendEmailLayer } from "../src/mailersend-email-sender.js";

export const mailersendNotificationLayer = (apiKey: Redacted.Redacted) =>
  mailersendEmailLayer({ apiKey });

export const mailersendNotification = Effect.gen(function* submitMailersendNotification() {
  const email = yield* Email;

  const attachment = yield* emailAttachmentFromBytes(
    new TextEncoder().encode("Fictional content"),
    {
      contentType: "ProviderSelected",
      filename: "example.txt",
    },
  );

  return yield* email.send({
    attachments: [attachment],
    body: { text: "This is a fictional MailerSend example." },
    from: "sender@example.test",
    subject: "Synthetic notification",
    to: "recipient@example.test",
  });
});

export const mailersendScheduledNotification = Effect.gen(
  function* scheduleMailersendNotification() {
    return yield* (yield* Email).send({
      body: { text: "This is a fictional scheduled MailerSend example." },
      from: "sender@example.test",
      sendAt: DateTime.add(yield* DateTime.now, { minutes: 10 }),
      subject: "Synthetic scheduled notification",
      to: "recipient@example.test",
    });
  },
);
