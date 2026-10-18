import { Effect } from "effect";
import { Email, observedEmailOperationLayer } from "../src/index.js";
import type { EmailOperationObserver } from "../src/index.js";
import { defaultedEmailLayer } from "../src/email-defaults.js";
import { recordingEmailLayer } from "../src/recording-email-sender.js";

export const fictionalObservedSubmission = (observer: EmailOperationObserver) =>
  Effect.gen(function* executeObservedNotification() {
    const operation = yield* (yield* Email).prepare(
      {
        body: { text: "A fictional lifecycle example, compiled but not executed." },
        from: "sender@fictional.invalid",
        subject: "Fictional notification",
        to: "recipient@fictional.invalid",
      },
      {
        executionMetadata: { tenant: "fictional-private-context" },
        idempotencyKey: "caller-owned-event",
      },
    );

    yield* operation.validate;

    return yield* operation.send;
  }).pipe(
    Effect.provide(
      observedEmailOperationLayer(
        defaultedEmailLayer(recordingEmailLayer, { idempotencyKeyPrefix: "fictional/" }),
        observer,
      ),
    ),
  );
