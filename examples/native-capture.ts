import { Effect, Redacted, Schema } from "effect";
import type { Layer } from "effect";
import {
  EmailNativeCapture,
  EmailNativeCapturePayloadSchema,
  capturedLoopsTransactionalLayer,
} from "../src/email-native-capture.js";
import { LoopsTransactionalEmail } from "../src/loops-transactional-email.js";
import type { LoopsTransactionalJobInput } from "../src/loops-transactional-job.js";

export const capturedNativeLoopsLayer = <E, R>(
  loopsLayer: Layer.Layer<LoopsTransactionalEmail, E, R>,
) =>
  capturedLoopsTransactionalLayer(loopsLayer, {
    capacity: 100,
    maxBytes: 8_388_608,
    privateData: "AuthorizePayloadCapture",
  });

export const inspectPrivateNativeCapture = (job: LoopsTransactionalJobInput) =>
  Effect.gen(function* submitAndInspectNativeCapture() {
    const loops = yield* LoopsTransactionalEmail;
    const receipt = yield* loops.send(job);
    const capture = yield* EmailNativeCapture;
    const snapshot = yield* capture.snapshot;

    const payloads = yield* Effect.forEach((payload: string) =>
      Schema.decodeEffect(Schema.fromJsonString(EmailNativeCapturePayloadSchema))(payload),
    )(snapshot.records.map((record) => Redacted.value(record.payloadJson)));

    const purgedRecordCount = yield* capture.purgeRecords;

    return { payloads, purgedRecordCount, receipt, snapshot };
  });
