import type { Redacted } from "effect";
import { Effect } from "effect";
import { Email, emailAttachmentFromBytes } from "../src/index.js";
import { mailgunEmailLayer, mailgunPersonalizedEmailLayer } from "../src/mailgun-email-sender.js";

export const mailgunNotificationLayer = (apiKey: Redacted.Redacted, domain: string) =>
  mailgunEmailLayer({ apiKey, domain, region: "Europe" });

export const mailgunNativePersonalizationLayer = (apiKey: Redacted.Redacted, domain: string) =>
  mailgunPersonalizedEmailLayer({ apiKey, domain, region: "Europe" });

export const mailgunNativeAudience = Effect.gen(function* submitMailgunNativeAudience() {
  return yield* (yield* Email).sendPersonalized({
    message: {
      body: { html: "<p>Hello %recipient.name%</p>", text: "Hello %recipient.name%" },
      from: "sender@example.test",
      subject: "Hello %recipient.name%",
    },
    recipients: [
      { to: "first@example.test", variables: { name: "First" } },
      { to: "second@example.test", variables: { name: "Second" } },
    ],
  });
});

export const mailgunNotification = Effect.gen(function* submitMailgunNotification() {
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
    body: { text: "This is a fictional Mailgun example." },
    from: "sender@example.test",
    metadata: { workflow: "synthetic" },
    subject: "Synthetic notification",
    to: "recipient@example.test",
  });
});
