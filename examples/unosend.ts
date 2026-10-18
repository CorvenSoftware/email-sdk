import type { Redacted } from "effect";
import { Effect } from "effect";
import { Email, emailAttachmentFromBlob } from "../src/index.js";
import { unosendEmailLayer } from "../src/unosend-email-sender.js";

export const unosendNotificationLayer = (apiKey: Redacted.Redacted) =>
  unosendEmailLayer({ apiKey });

export const unosendNotification = Effect.gen(function* submitUnosendNotification() {
  const email = yield* Email;

  const attachment = yield* emailAttachmentFromBlob(new Blob(["Fictional content"]), {
    contentType: "text/plain",
    filename: "example.txt",
  });

  return yield* email.send({
    attachments: [attachment],
    body: { text: "This is a fictional Unosend example." },
    from: "sender@example.test",
    subject: "Synthetic notification",
    to: "recipient@example.test",
  });
});
