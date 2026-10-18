import { DateTime, Effect, Redacted } from "effect";
import { Email, transformedEmailLayer } from "../src/index.js";
import { defaultedEmailLayer } from "../src/email-defaults.js";
import { resendEmailLayer } from "../src/resend-email-sender.js";

const account = transformedEmailLayer(
  defaultedEmailLayer(resendEmailLayer({ apiKey: Redacted.make("fictional-unused-key") }), {
    idempotencyKeyPrefix: "fictional-notifications/",
    replyTo: "replies@fictional.invalid",
  }),
  ({ message, options }) =>
    Effect.succeed({
      ...message,
      subject:
        options.executionMetadata?.priority === "urgent"
          ? `[Action requested] ${message.subject}`
          : message.subject,
    }),
);

export const fictionalTransformedSubmission = Effect.gen(function* prepareNotification() {
  const email = yield* Email;

  const operation = yield* email.prepare(
    {
      body: { text: "A fictional transformation example, compiled but not executed." },
      from: "sender@fictional.invalid",
      subject: "Fictional notification",
      to: "recipient@fictional.invalid",
    },
    {
      executionMetadata: {
        audit: {
          at: DateTime.makeUnsafe("2026-01-02T03:04:05.123Z"),
          flags: [0, false, null, undefined],
        },
        priority: "urgent",
      },
      idempotencyKey: "caller-owned-logical-event",
    },
  );

  return { preview: operation.previews[0], receipt: yield* operation.send };
}).pipe(Effect.provide(account));

export const fictionalContextualAudience = Effect.gen(function* prepareContextualAudience() {
  const email = yield* Email;

  return yield* email.sendPersonalized(
    {
      message: {
        body: { text: "Hello %recipient.name%. This example is compiled but not executed." },
        from: "sender@fictional.invalid",
        subject: "Fictional notification for %recipient.name%",
      },
      recipients: [
        { to: "first@fictional.invalid", variables: { name: "First" } },
        { to: "second@fictional.invalid", variables: { name: "Second" } },
      ],
    },
    { executionMetadata: { priority: "urgent" } },
  );
}).pipe(Effect.provide(account));
