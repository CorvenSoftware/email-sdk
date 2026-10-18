import { Effect } from "effect";
import type { Redacted } from "effect";
import { Email } from "../src/index.js";
import { plunkEmailLayer } from "../src/plunk-email-sender.js";

export const plunkNotificationLayer = (apiKey: Redacted.Redacted) =>
  plunkEmailLayer({ apiKey, contactWrites: "AllowUpsert", tracking: "ProjectDisabled" });

export const plunkNotification = Effect.gen(function* submitPlunkNotification() {
  return yield* (yield* Email).send(
    {
      body: { html: "<p>This is a fictional Plunk example.</p>" },
      from: "sender@example.test",
      subject: "Synthetic notification",
      to: "recipient@example.test",
    },
    { idempotencyKey: "fictional-job-key" },
  );
});
