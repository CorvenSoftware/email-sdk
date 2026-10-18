import type { Redacted } from "effect";
import { Effect } from "effect";
import { Email } from "../src/index.js";
import { heloEmailLayer } from "../src/helo-email-sender.js";

export const heloNotificationLayer = (apiKey: Redacted.Redacted, channelId: string) =>
  heloEmailLayer({ apiKey, channelId, channelMode: "Live" });

export const heloNotification = Effect.gen(function* submitHeloNotification() {
  return yield* (yield* Email).send(
    {
      body: { text: "This is a fictional Helo example." },
      from: "sender@example.test",
      subject: "Synthetic notification",
      tags: [{ name: "purpose", value: "example" }],
      to: "recipient@example.test",
    },
    { idempotencyKey: "fictional-job-key" },
  );
});
