import { Effect, Redacted } from "effect";
import { Email } from "../src/email-service.js";
import { brevoEmailLayer } from "../src/brevo-email-sender.js";

export const fictionalBrevoLayer = brevoEmailLayer({
  apiKey: Redacted.make("fictional-unused-key"),
  contentAuthority: "AuthorizeProviderRendering",
  submissionMode: "TransactionalOnly",
  tracking: "AuthorizeProviderTracking",
});

export const fictionalBrevoNotification = Effect.gen(function* submitFictionalBrevoNotification() {
  return yield* (yield* Email).send({
    body: { html: "<p>Fictional notification</p>" },
    from: "host@fictional.invalid",
    subject: "Fictional notification",
    to: "recipient@fictional.invalid",
  });
});
