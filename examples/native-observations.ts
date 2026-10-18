import { Effect, Redacted } from "effect";
import {
  EmailNativeObservations,
  observedLoopsTransactionalLayer,
} from "../src/email-native-observations.js";
import type {
  EmailNativeObserver,
  EmailNativeStartingObserver,
} from "../src/email-native-observations.js";
import {
  LoopsTransactionalEmail,
  loopsTransactionalLayer,
} from "../src/loops-transactional-email.js";

export const observedNativeLoopsLayer = (
  observer: EmailNativeObserver,
  startingObserver?: EmailNativeStartingObserver,
) =>
  observedLoopsTransactionalLayer(
    loopsTransactionalLayer({
      apiKey: Redacted.make("fictional-unused-key"),
      attachments: "Disabled",
      templateAuthority: "ProviderManaged",
    }),
    { capacity: 100 },
    observer,
    startingObserver,
  );

export const inspectNativeOperationFacts = Effect.gen(function* inspectNativeOperationFacts() {
  const loops = yield* LoopsTransactionalEmail;
  const view = yield* EmailNativeObservations;

  const preview = yield* loops.validate({
    email: "recipient@fictional.invalid",
    transactionalId: "fictional-template",
  });

  return { observations: yield* view.snapshot, preview };
});
