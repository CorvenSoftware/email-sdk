import { expectTypeOf } from "vitest";
import { Redacted } from "effect";
import type { Layer, Result, Effect } from "effect";
import type { HttpClient } from "effect/http";
import { ResendBatchEmail, resendBatchEmailLayer } from "../src/resend-email-sender.js";
import type {
  IResendBatchEmail,
  ResendBatchEmailOptionsInput,
  ResendBatchEmailResult,
} from "../src/resend-email-sender.js";
import type { EmailConfigurationError } from "../src/email-configuration-error.js";
import type { EmailDeliveryUnknown } from "../src/email-delivery-unknown.js";
import type { EmailSendError } from "../src/email-errors.js";
import type { EmailMessageInput, EmailReceipt } from "../src/email-message.js";

const readonlyBatchMessages: readonly [EmailMessageInput, ...EmailMessageInput[]] = [
  {
    body: { text: "Synthetic body" },
    from: "sender@example.test",
    subject: "Fictional",
    to: "recipient@example.test",
  },
];

const nativeBatchCall = ResendBatchEmail.use((batch) =>
  batch.send(readonlyBatchMessages, { idempotencyKey: "synthetic-batch" }),
);

const unkeyedBatchCall = ResendBatchEmail.use((batch) => batch.send(readonlyBatchMessages));

const invalidEmptyBatchCall = ResendBatchEmail.use((batch) =>
  // @ts-expect-error -- Native batch calls require at least one message.
  batch.send([]),
);

expectTypeOf(invalidEmptyBatchCall).toEqualTypeOf<typeof nativeBatchCall>();

expectTypeOf(nativeBatchCall).toEqualTypeOf<
  Effect.Effect<readonly ResendBatchEmailResult[], EmailSendError, ResendBatchEmail>
>();

expectTypeOf(unkeyedBatchCall).toEqualTypeOf<
  Effect.Effect<readonly ResendBatchEmailResult[], EmailSendError, ResendBatchEmail>
>();

expectTypeOf<ResendBatchEmailResult>().toEqualTypeOf<
  Result.Result<EmailReceipt, EmailDeliveryUnknown>
>();

expectTypeOf<keyof ResendBatchEmailOptionsInput>().toEqualTypeOf<"idempotencyKey">();

expectTypeOf<Parameters<IResendBatchEmail["send"]>[0]>().toEqualTypeOf<
  readonly [EmailMessageInput, ...EmailMessageInput[]]
>();

expectTypeOf<{
  readonly message: EmailMessageInput;
  readonly options: { readonly idempotencyKey: string };
}>().not.toExtend<Parameters<IResendBatchEmail["send"]>[0][number]>();

expectTypeOf<{ readonly idempotencyKey: number }>().not.toExtend<ResendBatchEmailOptionsInput>();

expectTypeOf(resendBatchEmailLayer({ apiKey: Redacted.make("synthetic-token") })).toEqualTypeOf<
  Layer.Layer<ResendBatchEmail, EmailConfigurationError, HttpClient.HttpClient>
>();
