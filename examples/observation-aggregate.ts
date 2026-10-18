import { Effect, Layer } from "effect";
import { EmailRouter, emailLayer, observedEmailRouterLayer } from "../src/index.js";
import {
  EmailObservationAggregate,
  observedEmailSenderLayer,
} from "../src/email-submission-observations.js";
import { recordingSenderLayer } from "../src/recording-email-sender.js";

const first = emailLayer().pipe(
  Layer.provideMerge(observedEmailSenderLayer(Layer.fresh(recordingSenderLayer), { capacity: 2 })),
);

const second = emailLayer().pipe(
  Layer.provideMerge(observedEmailSenderLayer(Layer.fresh(recordingSenderLayer), { capacity: 3 })),
);

const router = observedEmailRouterLayer(
  [
    { layer: first, name: "first" },
    { layer: second, name: "second" },
  ],
  { primary: "first" },
);

export const fictionalObservationAggregation = Effect.gen(function* queryNamedObservations() {
  const route = yield* (yield* EmailRouter).select({ primary: "second" });
  yield* route.send({
    body: { text: "A fictional fact aggregation example, compiled but not executed." },
    from: "sender@fictional.invalid",
    subject: "Fictional notification",
    to: "recipient@fictional.invalid",
  });

  return yield* (yield* EmailObservationAggregate).snapshot;
}).pipe(Effect.provide(router));
