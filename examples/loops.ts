import type { Redacted } from "effect";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import {
  LoopsTransactionalEmail,
  loopsTransactionalLayer,
} from "../src/loops-transactional-email.js";

export const syntheticLoopsNotification = Effect.gen(function* submitNativeLoopsTemplate() {
  const loops = yield* LoopsTransactionalEmail;

  return yield* loops.send(
    {
      dataVariables: { invoiceNumber: "fictional-invoice", total: 0 },
      email: "recipient@fictional.invalid",
      transactionalId: "fictional_published_template",
    },
    { idempotencyKey: "fictional-invoice-notification" },
  );
});

export const syntheticLoopsNotificationBatch = Effect.gen(function* submitNativeLoopsBatch() {
  const loops = yield* LoopsTransactionalEmail;

  return yield* loops.sendAll(
    [
      {
        job: {
          dataVariables: { invoiceNumber: "fictional-first", total: 0 },
          email: "first@fictional.invalid",
          transactionalId: "fictional_published_template",
        },
        options: { idempotencyKey: "fictional-first-notification" },
      },
      {
        job: {
          dataVariables: { invoiceNumber: "fictional-second", total: 2 },
          email: "second@fictional.invalid",
          transactionalId: "fictional_published_template",
        },
        options: { idempotencyKey: "fictional-second-notification" },
      },
    ],
    { concurrency: 2 },
  );
});

export const loopsNotificationLayer = (apiKey: Redacted.Redacted) =>
  loopsTransactionalLayer({
    apiKey,
    attachments: "Disabled",
    templateAuthority: "ProviderManaged",
  }).pipe(
    Layer.provide(
      FetchHttpClient.layer.pipe(
        Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { redirect: "manual" })),
      ),
    ),
  );
