import { Effect } from "effect";
import type { Layer } from "effect";
import {
  EmailNativeObservations,
  observedLoopsTransactionalLayer,
} from "../src/email-native-observations.js";
import type {
  EmailNativeObserver,
  EmailNativeStartingObserver,
} from "../src/email-native-observations.js";
import { LoopsTransactionalEmail } from "../src/loops-transactional-email.js";
import type { LoopsTransactionalJobInput } from "../src/loops-transactional-job.js";

export const observedNativeLoopsLayer = <E, R>(
  loopsLayer: Layer.Layer<LoopsTransactionalEmail, E, R>,
  observer: EmailNativeObserver,
  startingObserver?: EmailNativeStartingObserver,
) => observedLoopsTransactionalLayer(loopsLayer, { capacity: 100 }, observer, startingObserver);

export const inspectNativeOperationFacts = (job: LoopsTransactionalJobInput) =>
  Effect.gen(function* submitAndInspectNativeFacts() {
    const loops = yield* LoopsTransactionalEmail;
    const view = yield* EmailNativeObservations;
    const receipt = yield* loops.send(job);

    return { observations: yield* view.snapshot, receipt };
  });
