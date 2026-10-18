import { Effect, Layer } from "effect";
import { Email, emailLayer, capturedEmailRouterLayer } from "../src/index.js";
import {
  EmailCaptureAggregate,
  capturedEmailSenderLayer,
} from "../src/email-submission-capture.js";
import { recordingSenderLayer } from "../src/email-testing.js";

const options = {
  capacity: 100,
  maxBytes: 1_048_576,
  privateData: "AuthorizePayloadCapture",
} as const;

const primary = emailLayer().pipe(
  Layer.provideMerge(capturedEmailSenderLayer(Layer.fresh(recordingSenderLayer), options)),
);

const backup = emailLayer().pipe(
  Layer.provideMerge(capturedEmailSenderLayer(Layer.fresh(recordingSenderLayer), options)),
);

const router = capturedEmailRouterLayer(
  [
    { layer: primary, name: "primary" },
    { layer: backup, name: "backup" },
  ],
  { fallbacks: ["backup"], primary: "primary" },
);

export const fictionalAggregateCapture = Effect.gen(function* inspectFictionalAccounts() {
  yield* (yield* Email).send({
    body: { text: "A fictional recording example, compiled but not executed." },
    from: "sender@fictional.invalid",
    subject: "Fictional aggregate capture",
    to: "recipient@fictional.invalid",
  });

  return yield* (yield* EmailCaptureAggregate).snapshot;
}).pipe(Effect.provide(router));
