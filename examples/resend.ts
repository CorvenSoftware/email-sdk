import type { Redacted } from "effect";
import { DateTime, Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { Email } from "../src/index.js";
import type { EmailRetryObserver, EmailRetryRestriction } from "../src/index.js";
import { resendEmailLayer } from "../src/resend-email-sender.js";

export const sendNotification = Effect.gen(function* sendNotification() {
  const email = yield* Email;

  return yield* email.send(
    {
      body: {
        html: "<p>This is a fictional notification.</p>",
        text: "This is a fictional notification.",
      },
      from: "sender@example.test",
      subject: "Synthetic example",
      to: ["recipient@example.test"],
    },
    { idempotencyKey: "notification/event-1" },
  );
});

export const scheduleNotification = Effect.gen(function* scheduleNotification() {
  const sendAt = DateTime.add(yield* DateTime.now, { minutes: 10 });

  return yield* Email.use((email) =>
    email.send({
      body: { text: "A fictional scheduled notification." },
      from: "Synthetic Sender <sender@example.test>",
      sendAt,
      subject: "Synthetic scheduled example",
      to: "recipient@example.test",
    }),
  );
});

export const notificationLayer = (
  apiKey: Redacted.Redacted,
  observer?: EmailRetryObserver,
  restriction?: EmailRetryRestriction,
) =>
  resendEmailLayer({ apiKey }, undefined, observer, restriction).pipe(
    Layer.provide(
      FetchHttpClient.layer.pipe(
        Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { redirect: "manual" })),
      ),
    ),
  );
