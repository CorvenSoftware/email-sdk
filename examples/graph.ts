import { Effect } from "effect";
import type { Redacted } from "effect";
import { Email } from "../src/index.js";
import { graphEmailLayer } from "../src/graph-email-sender.js";

export const graphNotificationLayer = (accessToken: Redacted.Redacted, mailboxId: string) =>
  graphEmailLayer({
    accessToken,
    mailFlow: "ProviderUnmodified",
    mailboxAddress: "sender@example.test",
    mailboxId,
    senderIdentity: "OwnerOrSendAs",
    sentItems: "DoNotSave",
  });

export const graphNotification = Effect.gen(function* submitGraphNotification() {
  return yield* (yield* Email).send({
    body: { text: "This is a fictional mailbox-bound Microsoft Graph example." },
    from: { address: "sender@example.test", name: "Fictional Sender" },
    subject: "Synthetic notification",
    to: "recipient@example.test",
  });
});
