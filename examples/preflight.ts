import { Effect } from "effect";
import { preflightPostmarkEmail } from "../src/postmark-email-sender.js";
import { preflightResendEmail } from "../src/resend-email-sender.js";

const message = {
  body: { text: "A fictional credential-free preflight example, compiled but not executed." },
  from: "sender@fictional.invalid",
  subject: "Fictional notification",
  to: "recipient@fictional.invalid",
};

export const fictionalLocalPreflight = Effect.gen(function* inspectFictionalIntent() {
  const resend = yield* preflightResendEmail(message, { idempotencyKey: "caller-owned-event" });
  const postmark = yield* preflightPostmarkEmail(message);

  return { postmark, resend };
});
