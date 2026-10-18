import { Effect, Redacted, Schema } from "effect";
import {
  EmailNativeCapture,
  EmailNativeCapturePayloadSchema,
  capturedLoopsTransactionalLayer,
} from "../src/email-native-capture.js";
import {
  LoopsTransactionalEmail,
  loopsTransactionalLayer,
} from "../src/loops-transactional-email.js";

export const capturedNativeLoopsLayer = capturedLoopsTransactionalLayer(
  loopsTransactionalLayer({
    apiKey: Redacted.make("fictional-unused-key"),
    attachments: "Disabled",
    templateAuthority: "ProviderManaged",
  }),
  { capacity: 100, maxBytes: 8_388_608, privateData: "AuthorizePayloadCapture" },
);

export const inspectPrivateNativeCapture = Effect.gen(function* inspectPrivateNativeCapture() {
  const loops = yield* LoopsTransactionalEmail;
  yield* loops.validate({
    email: "recipient@fictional.invalid",
    transactionalId: "fictional-template",
  });
  const capture = yield* EmailNativeCapture;
  const snapshot = yield* capture.snapshot;

  const payloads = yield* Effect.forEach((payload: string) =>
    Schema.decodeEffect(Schema.fromJsonString(EmailNativeCapturePayloadSchema))(payload),
  )(snapshot.records.map((record) => Redacted.value(record.payloadJson)));

  const purgedRecordCount = yield* capture.purgeRecords;

  return { payloads, purgedRecordCount, snapshot };
});
