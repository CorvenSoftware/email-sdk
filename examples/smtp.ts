import { Effect } from "effect";
import type { Redacted } from "effect";
import { Email } from "../src/index.js";
import { SmtpAuthenticationSchema, smtpEmailLayer } from "../src/smtp-email-sender.js";

export const smtpNotificationLayer = (username: Redacted.Redacted, password: Redacted.Redacted) =>
  smtpEmailLayer({
    authentication: SmtpAuthenticationSchema.cases.Plain.make({ password, username }),
    helloName: "client.fictional.invalid",
    host: "smtp.fictional.invalid",
    mailFlow: "ProviderUnmodified",
    port: 465,
    security: "ImplicitTls",
  });

export const smtpNotification = Effect.gen(function* submitSmtpNotification() {
  return yield* (yield* Email).send({
    body: {
      html: "<p>This is a fictional SMTP notification.</p>",
      text: "This is a fictional SMTP notification.",
    },
    from: { address: "sender@example.test", name: "Fictional Sender" },
    subject: "Synthetic notification",
    to: "recipient@example.test",
  });
});
