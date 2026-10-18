import type { Redacted } from "effect";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { Email } from "../src/index.js";
import { postmarkEmailLayer } from "../src/postmark-email-sender.js";

export const sendPostmarkNotification = Effect.gen(function* sendPostmarkNotification() {
  return yield* (yield* Email).send({
    body: { text: "This is a fictional notification." },
    from: "sender@example.test",
    subject: "Synthetic Postmark example",
    to: ["recipient@example.test"],
  });
});

export const postmarkNotificationLayer = (serverToken: Redacted.Redacted) =>
  postmarkEmailLayer({ serverToken }).pipe(
    Layer.provide(
      FetchHttpClient.layer.pipe(
        Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { redirect: "manual" })),
      ),
    ),
  );
