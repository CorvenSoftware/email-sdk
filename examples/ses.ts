import { Effect } from "effect";
import type { Redacted } from "effect";
import { Email } from "../src/index.js";
import { sesEmailLayer } from "../src/ses-email-sender.js";

export const sesNotificationLayer = (
  accessKeyId: Redacted.Redacted,
  secretAccessKey: Redacted.Redacted,
  sessionToken: Redacted.Redacted,
) =>
  sesEmailLayer({
    accessKeyId,
    mailFlow: "ProviderUnmodified",
    region: "us-east-1",
    secretAccessKey,
    sessionToken,
  });

export const sesNotification = Effect.gen(function* submitSesNotification() {
  return yield* (yield* Email).send({
    body: {
      html: "<p>This is a fictional untracked SES notification.</p>",
      text: "This is a fictional untracked SES notification.",
    },
    from: { address: "sender@example.test", name: "Fictional Sender" },
    subject: "Synthetic notification",
    tags: [{ name: "workflow", value: "synthetic_notification" }],
    to: "recipient@example.test",
  });
});
