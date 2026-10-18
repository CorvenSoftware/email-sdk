import { Effect, Redacted } from "effect";
import { Email } from "../src/email-service.js";
import { sequenzyEmailLayer } from "../src/sequenzy-email-sender.js";

export const fictionalSequenzyLayer = sequenzyEmailLayer({
  apiKey: Redacted.make("fictional-unused-key"),
  automaticUtm: "AccountDisabled",
  contactWrites: "AuthorizeProviderManagedProfiles",
  contentAuthority: "AuthorizeProviderRenderingAndRetention",
  replyTracking: "AccountDisabled",
  senderIdentity: "ExistingVerifiedProfile",
  submissionMode: "TransactionalOnly",
});

export const fictionalSequenzyNotification = Effect.gen(
  function* submitFictionalSequenzyNotification() {
    return yield* (yield* Email).send(
      {
        body: { html: "<p>Fictional notification</p>" },
        from: { address: "host@fictional.invalid", name: "Fictional existing identity" },
        replyTo: "reply@fictional.invalid",
        subject: "Fictional notification",
        to: "recipient@fictional.invalid",
      },
      { idempotencyKey: "fictional-notification" },
    );
  },
);
