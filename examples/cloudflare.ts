import { Effect } from "effect";
import type { Redacted } from "effect";
import { Email } from "../src/index.js";
import { cloudflareEmailLayer } from "../src/cloudflare-email-sender.js";

export const cloudflareNotificationLayer = (apiToken: Redacted.Redacted, accountId: string) =>
  cloudflareEmailLayer({ accountId, apiToken, mailFlow: "ProviderUnmodified" });

export const cloudflareNotification = Effect.gen(function* submitCloudflareNotification() {
  return yield* (yield* Email).send({
    body: {
      html: "<p>This is a fictional Cloudflare REST example.</p>",
      text: "This is a fictional Cloudflare REST example.",
    },
    from: { address: "sender@example.test", name: "Fictional Sender" },
    subject: "Synthetic notification",
    to: "recipient@example.test",
  });
});
