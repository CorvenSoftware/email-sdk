import { Effect, Ref } from "effect";
import type { Scope } from "effect";
import {
  appendEmailCapture,
  closeEmailCapture,
  markEmailCaptureGap,
  purgeEmailCapture,
} from "./email-capture-retention.js";
import type { EmailCaptureOptions, EmailCaptureSnapshot } from "./email-capture-retention.js";

interface EmailCaptureStore {
  readonly append: (payloadJson: string) => Effect.Effect<void>;
  readonly closed: Effect.Effect<boolean>;
  readonly markGap: Effect.Effect<void>;
  readonly purgeRecords: Effect.Effect<number>;
  readonly snapshot: Effect.Effect<EmailCaptureSnapshot>;
}

export const acquireEmailCaptureStore = Effect.fnUntraced(function* acquireEmailCaptureStore(
  options: EmailCaptureOptions,
): Effect.fn.Return<EmailCaptureStore, never, Scope.Scope> {
  const captured = yield* Ref.make<EmailCaptureSnapshot>(
    Object.freeze({
      closed: false,
      records: Object.freeze([]),
      retainedBytes: 0,
      truncated: false,
    }),
  );

  yield* Effect.addFinalizer(() => Ref.update(captured, closeEmailCapture));

  return {
    append: (payloadJson: string) =>
      Ref.update(captured, (current) => appendEmailCapture(current, payloadJson, options)),
    closed: Ref.get(captured).pipe(Effect.map((current) => current.closed)),
    markGap: Ref.update(captured, markEmailCaptureGap),
    purgeRecords: Ref.modify(captured, purgeEmailCapture),
    snapshot: Ref.get(captured),
  };
});
