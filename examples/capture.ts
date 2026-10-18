import { Effect, Layer } from "effect";
import { Email, emailLayer } from "../src/email-service.js";
import type { EmailMessageInput } from "../src/email-message.js";
import {
  capturedEmailSenderLayer,
  EmailSubmissionCapture,
} from "../src/email-submission-capture.js";
import { recordingSenderLayer } from "../src/recording-email-sender.js";

export const captureSyntheticSubmission = Effect.fnUntraced(function* captureSyntheticSubmission(
  message: EmailMessageInput,
) {
  const email = yield* Email;
  const capture = yield* EmailSubmissionCapture;
  const receipt = yield* email.send(message);
  const snapshot = yield* capture.snapshot;
  const purgedRecordCount = yield* capture.purgeRecords;

  return { purgedRecordCount, receipt, snapshot };
});

export const capturedSyntheticEmailLayer = emailLayer().pipe(
  Layer.provideMerge(
    capturedEmailSenderLayer(recordingSenderLayer, {
      capacity: 10,
      maxBytes: 1_048_576,
      privateData: "AuthorizePayloadCapture",
    }),
  ),
);
