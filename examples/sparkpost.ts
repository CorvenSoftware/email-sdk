import { Effect } from "effect";
import type { DateTime, Redacted } from "effect";
import { Email } from "../src/index.js";
import { sparkpostEmailLayer } from "../src/sparkpost-email-sender.js";

export const sparkpostNotificationLayer = (apiKey: Redacted.Redacted) =>
  sparkpostEmailLayer({ apiKey, region: "Europe" });

export const sparkpostNotification = Effect.gen(function* submitSparkpostNotification() {
  return yield* (yield* Email).send(
    {
      body: { text: "This is a fictional SparkPost example." },
      from: "sender@example.test",
      subject: "Synthetic notification",
      to: "recipient@example.test",
    },
    { idempotencyKey: "fictional-job-key" },
  );
});

export const sparkpostScheduledNotification = Effect.fnUntraced(
  function* submitScheduledSparkpostNotification(sendAt: DateTime.Utc, idempotencyKey: string) {
    return yield* (yield* Email).send(
      {
        body: { text: "This is a fictional scheduled SparkPost example." },
        from: "sender@example.test",
        sendAt,
        subject: "Synthetic scheduled notification",
        to: "recipient@example.test",
      },
      { idempotencyKey },
    );
  },
);
