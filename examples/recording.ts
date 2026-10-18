import { Effect } from "effect";
import { Email, emailAttachmentFromBytes } from "../src/index.js";
import { RecordedEmails, recordingEmailLayer } from "../src/recording-email-sender.js";

export const recordNotification = Effect.gen(function* recordNotification() {
  const email = yield* Email;
  const records = yield* RecordedEmails;

  const attachment = yield* emailAttachmentFromBytes(
    new TextEncoder().encode("Fictional attachment content."),
    { contentType: "text/plain", filename: "example.txt" },
  );

  const receipt = yield* email.send({
    attachments: [attachment],
    body: { text: "This fictional notification stays in memory." },
    from: "sender@example.test",
    subject: "Synthetic example",
    to: ["recipient@example.test"],
  });

  const messages = yield* records.messages;
  const purgedMessageCount = yield* records.purgeMessages;

  return { messages, purgedMessageCount, receipt };
}).pipe(Effect.provide(recordingEmailLayer));
