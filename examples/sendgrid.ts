import type { Redacted } from "effect";
import { DateTime, Effect } from "effect";
import { Email } from "../src/index.js";
import {
  sendgridEmailLayer,
  sendgridPersonalizedEmailLayer,
} from "../src/sendgrid-email-sender.js";

export const sendgridNotificationLayer = (apiKey: Redacted.Redacted) =>
  sendgridEmailLayer({ apiKey, region: "Europe" });

export const sendgridNativePersonalizationLayer = (apiKey: Redacted.Redacted) =>
  sendgridPersonalizedEmailLayer({ apiKey, region: "Europe" });

export const sendgridNativeAudience = Effect.gen(function* submitSendgridNativeAudience() {
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

export const sendgridNotification = Effect.gen(function* submitSendgridNotification() {
  const email = yield* Email;

  return yield* email.send({
    body: { text: "This is a fictional SendGrid example." },
    from: { address: "sender@example.test", name: "Synthetic Sender" },
    metadata: { workflow: "synthetic" },
    subject: "Synthetic notification",
    to: "recipient@example.test",
  });
});

export const sendgridScheduledNotification = Effect.gen(function* scheduleSendgridNotification() {
  const now = yield* DateTime.now;

  const sendAt = DateTime.makeUnsafe(
    Math.ceil(DateTime.toEpochMillis(now) / 1000) * 1000 + 600_000,
  );

  return yield* (yield* Email).send({
    body: { text: "This is a fictional scheduled SendGrid example." },
    from: "sender@example.test",
    sendAt,
    subject: "Synthetic scheduled notification",
    to: "recipient@example.test",
  });
});
