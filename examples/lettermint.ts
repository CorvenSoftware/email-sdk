import type { Redacted } from "effect";
import { Effect } from "effect";
import { Email, EmailReceiptSchema } from "../src/index.js";
import { lettermintEmailLayer } from "../src/lettermint-email-sender.js";

export const lettermintNotificationLayer = (apiToken: Redacted.Redacted) =>
  lettermintEmailLayer({ apiToken, route: "transactional" });

export const lettermintNotification = Effect.gen(function* submitLettermintNotification() {
  const email = yield* Email;

  const receipt = yield* email.send(
    {
      body: { text: "This is a fictional Lettermint example." },
      from: "sender@example.test",
      subject: "Synthetic notification",
      tags: [{ name: "purpose", value: "example" }],
      to: "recipient@example.test",
    },
    { idempotencyKey: "fictional-job-key" },
  );

  return { receipt, simulated: EmailReceiptSchema.guards.Simulated(receipt) };
});
