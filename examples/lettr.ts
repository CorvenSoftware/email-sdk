import { DateTime, Effect } from "effect";
import type { Redacted } from "effect";
import { Email } from "../src/index.js";
import { lettrEmailLayer } from "../src/lettr-email-sender.js";

export const lettrNotificationLayer = (apiKey: Redacted.Redacted) =>
  lettrEmailLayer({ apiKey, submissionMode: "Immediate" });

export const lettrNotification = Effect.gen(function* submitLettrNotification() {
  return yield* (yield* Email).send(
    {
      body: { text: "This is a fictional Lettr example." },
      from: "sender@example.test",
      subject: "Synthetic notification",
      to: "recipient@example.test",
    },
    { idempotencyKey: "fictional-job-key" },
  );
});

export const lettrScheduleLayer = (apiKey: Redacted.Redacted) =>
  lettrEmailLayer({ apiKey, submissionMode: "Scheduled" });

export const lettrScheduledNotification = Effect.gen(function* scheduleLettrNotification() {
  return yield* (yield* Email).send({
    body: { text: "This fictional example is held for future sending." },
    from: "sender@example.test",
    sendAt: DateTime.add(yield* DateTime.now, { minutes: 10 }),
    subject: "Synthetic scheduled notification",
    to: "recipient@example.test",
  });
});
