import type { Redacted } from "effect";
import { Effect } from "effect";
import { EmailRouter, emailRouterLayer } from "../src/index.js";
import { resendEmailLayer } from "../src/resend-email-sender.js";
import { postmarkEmailLayer } from "../src/postmark-email-sender.js";

export const notificationRoutes = (
  resendKey: Redacted.Redacted,
  postmarkToken: Redacted.Redacted,
) =>
  emailRouterLayer(
    [
      { layer: resendEmailLayer({ apiKey: resendKey }), name: "transactional" },
      { layer: postmarkEmailLayer({ serverToken: postmarkToken }), name: "secondary" },
    ],
    { fallbacks: ["secondary"], primary: "transactional" },
  );

export const routedNotification = Effect.gen(function* submitRoutedNotification() {
  const router = yield* EmailRouter;
  const route = yield* router.select();

  return yield* route.send({
    body: { text: "This is a fictional routing example." },
    from: "sender@example.test",
    subject: "Synthetic routing notification",
    to: "recipient@example.test",
  });
});
