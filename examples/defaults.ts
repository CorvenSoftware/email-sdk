import { Effect, Redacted } from "effect";
import { Email } from "../src/index.js";
import { defaultedEmailLayer } from "../src/email-defaults.js";
import { resendEmailLayer } from "../src/resend-email-sender.js";

const account = resendEmailLayer({ apiKey: Redacted.make("fictional-unused-key") });

const defaultedAccount = defaultedEmailLayer(account, {
  headers: [{ name: "X-Application", value: "fictional-example" }],
  idempotencyKeyPrefix: "fictional-application/",
  replyTo: { address: "replies@fictional.invalid", name: "Fictional application" },
  tags: [{ name: "application", value: "fictional-example" }],
});

export const fictionalDefaultedSubmission = Effect.gen(function* sendDefaultedNotification() {
  const email = yield* Email;

  return yield* email.send(
    {
      body: { text: "A fictional defaults example, compiled but not executed." },
      from: "sender@fictional.invalid",
      subject: "Fictional notification",
      to: "recipient@fictional.invalid",
    },
    { idempotencyKey: "caller-owned-logical-event" },
  );
}).pipe(Effect.provide(defaultedAccount));
