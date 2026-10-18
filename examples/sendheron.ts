import { Effect, Redacted } from "effect";
import { Email } from "../src/email-service.js";
import { sendheronEmailLayer } from "../src/sendheron-email-sender.js";

export const fictionalSendheronLayer = sendheronEmailLayer({
  apiKey: Redacted.make("fictional-unused-key"),
  submissionMode: "TransactionalOnly",
  tracking: "AuthorizeProviderTracking",
});

export const fictionalSendheronNotification = Effect.gen(
  function* submitFictionalSendheronNotification() {
    return yield* (yield* Email).send(
      {
        body: { html: "<p>Fictional notification</p>" },
        from: { address: "host@fictional.invalid", name: "Fictional Host" },
        replyTo: "reply@fictional.invalid",
        subject: "Fictional notification",
        to: "recipient@fictional.invalid",
      },
      { idempotencyKey: "fictional-notification" },
    );
  },
);
