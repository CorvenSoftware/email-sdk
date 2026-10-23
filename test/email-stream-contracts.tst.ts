import { Context, Effect, Result, Schema, Stream } from "effect";
import { expectTypeOf } from "vitest";
import type { EmailConfigurationError } from "../src/email-configuration-error.js";
import type { EmailSendError } from "../src/email-errors.js";
import type { EmailInvalidOptions } from "../src/email-invalid-options.js";
import type { EmailReceipt } from "../src/email-message.js";
import type { EmailSendRequest } from "../src/email-preparation.js";
import type { Email } from "../src/email-service.js";
import { sendEmailStream } from "../src/email-stream.js";
import type { EmailStreamOutcome } from "../src/email-stream.js";
import { recordingEmailLayer } from "../src/recording-email-sender.js";

const FictionalStreamFailureSchema = Schema.TaggedStruct("FictionalStreamFailure", {
  reason: Schema.Literal("unavailable"),
});

type FictionalStreamFailure = typeof FictionalStreamFailureSchema.Type;

class StreamAudience extends Context.Service<
  StreamAudience,
  {
    readonly next: Effect.Effect<EmailSendRequest, FictionalStreamFailure>;
  }
>()("@corvencore/email-sdk/test/StreamAudience") {}

const request = {
  message: {
    body: { text: "A fictional stream type contract." },
    from: "sender@example.test",
    subject: "Fictional stream",
    to: "recipient@example.test",
  },
} satisfies EmailSendRequest;

const source = Stream.fromEffect(
  Effect.gen(function* readFictionalStreamAudience() {
    const audience = yield* StreamAudience;

    return yield* audience.next;
  }),
);

const pending = sendEmailStream(source, { concurrency: 2 });

expectTypeOf(pending).toEqualTypeOf<
  Stream.Stream<
    EmailStreamOutcome,
    FictionalStreamFailure | EmailInvalidOptions,
    StreamAudience | Email
  >
>();

const consumed = pending.pipe(
  Stream.runForEach((outcome) => {
    expectTypeOf(outcome.index).toEqualTypeOf<number>();
    expectTypeOf(outcome.result).toEqualTypeOf<Result.Result<EmailReceipt, EmailSendError>>();

    return Result.match(outcome.result, {
      onFailure: (failure) => {
        expectTypeOf(failure).toEqualTypeOf<EmailSendError>();

        return Effect.void;
      },
      onSuccess: (receipt) => {
        expectTypeOf(receipt).toEqualTypeOf<EmailReceipt>();

        return Effect.void;
      },
    });
  }),
);

expectTypeOf(consumed).toEqualTypeOf<
  Effect.Effect<void, FictionalStreamFailure | EmailInvalidOptions, StreamAudience | Email>
>();

const recorded = consumed.pipe(Effect.provide(recordingEmailLayer));

expectTypeOf(recorded).toEqualTypeOf<
  Effect.Effect<
    void,
    FictionalStreamFailure | EmailInvalidOptions | EmailConfigurationError,
    StreamAudience
  >
>();

const supplied = recorded.pipe(
  Effect.provideService(StreamAudience, {
    next: Effect.succeed(request),
  }),
);

expectTypeOf(supplied).toEqualTypeOf<
  Effect.Effect<void, FictionalStreamFailure | EmailInvalidOptions | EmailConfigurationError>
>();

const finite = sendEmailStream(Stream.make(request));

expectTypeOf(finite).toEqualTypeOf<Stream.Stream<EmailStreamOutcome, EmailInvalidOptions, Email>>();

expectTypeOf<Stream.Stream<string>>().not.toExtend<Parameters<typeof sendEmailStream>[0]>();
