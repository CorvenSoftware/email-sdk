import type { Redacted } from "effect";
import { Effect } from "effect";
import { Email, emailAttachmentFromBytes } from "../src/index.js";
import { mailpaceEmailLayer } from "../src/mailpace-email-sender.js";

export const mailpaceNotificationLayer = (serverToken: Redacted.Redacted) =>
  mailpaceEmailLayer({ serverToken });

export const mailpaceNotification = Effect.gen(function* submitMailpaceNotification() {
  const email = yield* Email;

  const attachment = yield* emailAttachmentFromBytes(
    new TextEncoder().encode("Fictional content"),
    {
      contentType: "text/plain",
      filename: "example.txt",
    },
  );

  return yield* email.send({
    attachments: [attachment],
    body: { text: "This is a fictional MailPace example." },
    from: "sender@example.test",
    headers: [{ name: "List-Unsubscribe", value: "<mailto:unsubscribe@example.test>" }],
    subject: "Synthetic notification",
    to: "recipient@example.test",
  });
});
