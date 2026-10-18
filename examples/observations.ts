import { Effect, Layer } from "effect";
import { Email, emailLayer } from "../src/email-service.js";
import type { EmailMessageInput } from "../src/email-message.js";
import {
  EmailSubmissionObservations,
  observedEmailSenderLayer,
} from "../src/email-submission-observations.js";
import type {
  EmailSubmissionObserver,
  EmailSubmissionStartingObserver,
} from "../src/email-submission-observations.js";
import { recordingSenderLayer } from "../src/recording-email-sender.js";

export const submitAndInspectSyntheticEmail = Effect.fnUntraced(
  function* submitAndInspectSyntheticEmail(message: EmailMessageInput) {
    const email = yield* Email;
    const observations = yield* EmailSubmissionObservations;
    const receipt = yield* email.send(message);
    const snapshot = yield* observations.snapshot;

    return { receipt, snapshot };
  },
);

export const observedSyntheticEmailLayer = (
  observer: EmailSubmissionObserver,
  startingObserver?: EmailSubmissionStartingObserver,
) =>
  emailLayer().pipe(
    Layer.provideMerge(
      observedEmailSenderLayer(recordingSenderLayer, { capacity: 10 }, observer, startingObserver),
    ),
  );
