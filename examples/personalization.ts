import { Effect } from "effect";
import { Email, renderEmailPersonalizedMessage } from "../src/index.js";
import { recordingEmailLayer } from "../src/recording-email-sender.js";

const template = {
  body: { html: "<p>Hello %recipient.name%</p>", text: "Hello %recipient.name%" },
  from: { address: "sender@example.test", name: "Synthetic Sender" },
  subject: "Hello %recipient.name%",
} as const;

export const personalizedPreview = renderEmailPersonalizedMessage(template, {
  to: "first@example.test",
  variables: { name: "Fictional & synthetic" },
});

export const recordedPersonalization = Effect.gen(function* recordPersonalizedNotifications() {
  return yield* (yield* Email).sendPersonalized(
    {
      message: template,
      recipients: [
        {
          idempotencyKey: "synthetic/first",
          to: "first@example.test",
          variables: { name: "First" },
        },
        {
          idempotencyKey: "synthetic/second",
          to: "second@example.test",
          variables: { name: "Second" },
        },
      ],
    },
    { concurrency: 2 },
  );
}).pipe(Effect.provide(recordingEmailLayer));
