import { Buffer } from "node:buffer";
import { Redacted, Schema } from "effect";
import { EmailDeliveryUnknown } from "./email-delivery-unknown.js";
import { EmailReceiptSchema } from "./email-message.js";
import { EmailRejected } from "./email-rejected.js";

export const EmailCaptureOutcomeSchema = Schema.TaggedUnion({
  Aborted: { defect: Schema.Boolean, interrupted: Schema.Boolean },
  Receipt: { receipt: EmailReceiptSchema },
  Rejected: { failure: EmailRejected },
  Unknown: { failure: EmailDeliveryUnknown },
});

export const EmailCaptureOptionsSchema = Schema.Struct({
  capacity: Schema.Int.check(Schema.isBetween({ maximum: 10_000, minimum: 1 })),
  maxBytes: Schema.Int.check(Schema.isBetween({ maximum: 67_108_864, minimum: 1 })),
  privateData: Schema.Literal("AuthorizePayloadCapture"),
});

export type EmailCaptureOptions = typeof EmailCaptureOptionsSchema.Encoded;

export const EmailCaptureRecordSchema = Schema.Struct({
  byteLength: Schema.Int.check(Schema.isBetween({ maximum: 67_108_864, minimum: 1 })),
  payloadJson: Schema.Redacted(Schema.String, { disallowJsonEncode: true }),
});

export type EmailCaptureRecord = typeof EmailCaptureRecordSchema.Type;

export const EmailCaptureSnapshotSchema = Schema.Struct({
  closed: Schema.Boolean,
  records: Schema.Array(EmailCaptureRecordSchema),
  retainedBytes: Schema.Int.check(Schema.isBetween({ maximum: 67_108_864, minimum: 0 })),
  truncated: Schema.Boolean,
});

export type EmailCaptureSnapshot = typeof EmailCaptureSnapshotSchema.Type;

export const appendEmailCapture = (
  current: EmailCaptureSnapshot,
  payloadJson: string,
  options: EmailCaptureOptions,
): EmailCaptureSnapshot => {
  if (current.closed) {
    return current;
  }

  const byteLength = Buffer.byteLength(payloadJson, "utf-8");

  if (byteLength > options.maxBytes) {
    return Object.freeze({ ...current, truncated: true });
  }

  let retainedBytes = current.retainedBytes + byteLength;
  let evictedCount = 0;

  for (const record of current.records) {
    if (
      current.records.length - evictedCount < options.capacity &&
      retainedBytes <= options.maxBytes
    ) {
      break;
    }

    retainedBytes -= record.byteLength;
    evictedCount += 1;
  }

  const records = current.records.slice(evictedCount);

  records.push(
    Object.freeze({ byteLength, payloadJson: Object.freeze(Redacted.make(payloadJson)) }),
  );

  return Object.freeze({
    closed: false,
    records: Object.freeze(records),
    retainedBytes,
    truncated: current.truncated || evictedCount > 0,
  });
};

export const closeEmailCapture = (current: EmailCaptureSnapshot): EmailCaptureSnapshot =>
  Object.freeze({
    closed: true,
    records: Object.freeze([]),
    retainedBytes: 0,
    truncated: current.truncated,
  });

export const markEmailCaptureGap = (current: EmailCaptureSnapshot): EmailCaptureSnapshot =>
  current.closed ? current : Object.freeze({ ...current, truncated: true });

export const purgeEmailCapture = (
  current: EmailCaptureSnapshot,
): readonly [number, EmailCaptureSnapshot] => {
  const count = current.records.length;

  if (count === 0) {
    return [0, current];
  }

  return [
    count,
    Object.freeze({ ...current, records: Object.freeze([]), retainedBytes: 0, truncated: true }),
  ];
};
