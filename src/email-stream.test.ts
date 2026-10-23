import { assert, describe, it } from "@effect/vitest";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Match,
  Queue,
  Ref,
  Result,
  Stream,
} from "effect";
import { EmailInvalidMessage } from "./email-invalid-message.js";
import { EmailInvalidOptions } from "./email-invalid-options.js";
import { EmailReceiptSchema } from "./email-message.js";
import type { EmailMessage, EmailMessageInput } from "./email-message.js";
import { observedEmailOperationLayer } from "./email-operation-observations.js";
import type { EmailSendRequest } from "./email-preparation.js";
import { EmailRejected } from "./email-rejected.js";
import { emailRouterLayer } from "./email-routing.js";
import { EmailSender, EmailSenderIdempotencySchema } from "./email-sender.js";
import type { IEmailSender } from "./email-sender.js";
import { Email, emailLayer } from "./email-service.js";
import { sendEmailStream } from "./email-stream.js";
import { transformedEmailLayer } from "./email-transformation.js";
import { recordingEmailCapabilities, recordingEmailLayer } from "./recording-email-sender.js";

const message: EmailMessageInput = {
  body: { text: "A fictional stream notification." },
  from: "sender@example.test",
  subject: "Fictional stream",
  to: "recipient@example.test",
};

const receipt = EmailReceiptSchema.cases.Recorded.make({ sequence: 1 });

const suppliedEmailLayer = (
  submit: IEmailSender["submit"],
  validate: IEmailSender["validate"] = () => Effect.void,
) =>
  emailLayer().pipe(
    Layer.provide(
      Layer.succeed(EmailSender, {
        capabilities: recordingEmailCapabilities,
        idempotency: EmailSenderIdempotencySchema.cases.KeyForwarding.make({}),
        provider: "fixture",
        submit,
        validate,
      }),
    ),
  );

describe("sendEmailStream", () => {
  it.effect("makes progress for a sparse source that stays open", () =>
    Effect.gen(function* sparseEmailStream() {
      const input = yield* Queue.unbounded<EmailSendRequest>();
      const outcomes = yield* Queue.unbounded<number>();

      const fiber = yield* sendEmailStream(Stream.fromQueue(input)).pipe(
        Stream.take(2),
        Stream.tap((outcome) => Queue.offer(outcomes, outcome.index)),
        Stream.runCollect,
        Effect.provide(recordingEmailLayer),
        Effect.forkScoped,
      );

      yield* Queue.offer(input, { message });
      assert.strictEqual(yield* Queue.take(outcomes), 0);
      yield* Queue.offer(input, { message: { ...message, subject: "Later notification" } });
      assert.strictEqual(yield* Queue.take(outcomes), 1);
      const result = yield* Fiber.join(fiber);
      assert.deepStrictEqual(
        result.map((outcome) => outcome.result),
        [
          Result.succeed(EmailReceiptSchema.cases.Recorded.make({ sequence: 1 })),
          Result.succeed(EmailReceiptSchema.cases.Recorded.make({ sequence: 2 })),
        ],
      );
    }),
  );

  it.effect("rejects invalid options before pulling even an empty source", () =>
    Effect.gen(function* validateStreamOptions() {
      const pulls = yield* Ref.make(0);
      const source = Stream.unwrap(Ref.update(pulls, (n) => n + 1).pipe(Effect.as(Stream.empty)));

      for (const concurrency of [0, 33, 1.5]) {
        const failure = yield* sendEmailStream(source, { concurrency }).pipe(
          Stream.runCollect,
          Effect.flip,
          Effect.provide(recordingEmailLayer),
        );

        assert.strictEqual(failure._tag, "EmailInvalidOptions");
      }

      assert.strictEqual(yield* Ref.get(pulls), 0);
      assert.deepStrictEqual(
        yield* sendEmailStream(source).pipe(Stream.runCollect, Effect.provide(recordingEmailLayer)),
        [],
      );
      assert.strictEqual(yield* Ref.get(pulls), 1);
    }),
  );

  it.effect("keeps global indexes and settles invalid items without stopping later sends", () =>
    Effect.gen(function* settleStreamItems() {
      const rejected = new EmailRejected({ provider: "fixture", reason: "authentication" });
      const invalidWrapper = { message, unsupported: "private-wrapper-value" };

      const source = Stream.make(
        { message },
        { message: { ...message, subject: "invalid\nsubject" } },
      ).pipe(
        Stream.concat(
          Stream.make(
            invalidWrapper,
            { message, options: { idempotencyKey: "private invalid key" } },
            { message: { ...message, subject: "rejected" } },
            { message: { ...message, subject: "last" } },
          ),
        ),
      );

      const results = yield* sendEmailStream(source).pipe(
        Stream.runCollect,
        Effect.provide(
          suppliedEmailLayer((submission) =>
            submission.message.subject === "rejected"
              ? Effect.fail(rejected)
              : Effect.succeed(receipt),
          ),
        ),
      );

      assert.deepStrictEqual(
        results.map((outcome) => outcome.index),
        [0, 1, 2, 3, 4, 5],
      );
      assert.deepStrictEqual(
        results.map((outcome) =>
          Result.match(outcome.result, {
            onFailure: (failure) => failure._tag,
            onSuccess: (success) => success._tag,
          }),
        ),
        [
          "Recorded",
          "EmailInvalidMessage",
          "EmailInvalidOptions",
          "EmailInvalidOptions",
          "EmailRejected",
          "Recorded",
        ],
      );
      const invalid = results[1]?.result;
      assert.isDefined(invalid);
      assert(Result.isFailure(invalid));
      assert(invalid.failure instanceof EmailInvalidMessage);
      assert(invalid.failure.issues.some((issue) => issue.path === "message.subject"));
      const invalidOptions = results[3]?.result;
      assert.isDefined(invalidOptions);
      assert(Result.isFailure(invalidOptions));
      assert(invalidOptions.failure instanceof EmailInvalidOptions);
      assert(
        invalidOptions.failure.issues.some((issue) => issue.path === "options.idempotencyKey"),
      );
      assert.notInclude(JSON.stringify(results), "private");
      const rejectedResult = results[4]?.result;
      assert.isDefined(rejectedResult);
      assert(Result.isFailure(rejectedResult));
      assert.strictEqual(rejectedResult.failure, rejected);
    }),
  );

  it.effect("bounds pulls and active sends while preserving order after reverse completion", () =>
    Effect.gen(function* boundOrderedEmailStream() {
      const started = yield* Queue.unbounded<string>();
      const first = yield* Deferred.make<true>();
      const second = yield* Deferred.make<true>();
      const secondDone = yield* Deferred.make<true>();
      const pulled = yield* Ref.make(0);
      const active = yield* Ref.make(0);
      const peak = yield* Ref.make(0);
      const emitted = yield* Ref.make<readonly number[]>([]);

      const source = Stream.fromIterable(["first", "second", "third", "fourth"]).pipe(
        Stream.map((subject) => ({ message: { ...message, subject } })),
        Stream.tap(() => Ref.update(pulled, (n) => n + 1)),
      );

      const account = suppliedEmailLayer((submission) =>
        Effect.gen(function* submitOrderedStreamItem() {
          const count = yield* Ref.updateAndGet(active, (n) => n + 1);
          yield* Ref.update(peak, (n) => Math.max(n, count));
          yield* Queue.offer(started, submission.message.subject);

          if (submission.message.subject === "first") {
            yield* Deferred.await(first);
          }

          if (submission.message.subject === "second") {
            yield* Deferred.await(second);
            yield* Deferred.succeed(secondDone, true);
          }

          return receipt;
        }).pipe(Effect.ensuring(Ref.update(active, (n) => n - 1))),
      );

      const fiber = yield* sendEmailStream(source, { concurrency: 2 }).pipe(
        Stream.tap((outcome) => Ref.update(emitted, (indexes) => [...indexes, outcome.index])),
        Stream.runCollect,
        Effect.provide(account),
        Effect.forkScoped,
      );

      assert.deepStrictEqual(
        [yield* Queue.take(started), yield* Queue.take(started)],
        ["first", "second"],
      );
      assert.strictEqual(yield* Ref.get(pulled), 2);
      yield* Deferred.succeed(second, true);
      yield* Deferred.await(secondDone);
      assert.deepStrictEqual(yield* Ref.get(emitted), []);
      assert.strictEqual(yield* Ref.get(pulled), 2);
      yield* Deferred.succeed(first, true);
      const outcomes = yield* Fiber.join(fiber);
      assert.deepStrictEqual(
        outcomes.map((outcome) => outcome.index),
        [0, 1, 2, 3],
      );
      assert(outcomes.every((outcome) => Result.isSuccess(outcome.result)));
      assert.strictEqual(yield* Ref.get(peak), 2);
      assert.strictEqual(yield* Ref.get(active), 0);
      assert.strictEqual(yield* Ref.get(pulled), 4);
    }),
  );

  it.effect("owns consumed inputs and transforms each item once in source order", () =>
    Effect.gen(function* ownWaitingStreamInputs() {
      const entered = yield* Deferred.make<true>();
      const release = yield* Deferred.make<true>();
      const transforms = yield* Ref.make<readonly string[]>([]);
      const submitted = yield* Ref.make<readonly EmailMessage[]>([]);

      const attachment = {
        contentBase64: "AQ==",
        contentType: "application/octet-stream",
        filename: "fictional.bin",
      };

      const waiting = {
        message: {
          ...message,
          attachments: [attachment] satisfies [typeof attachment],
          subject: "waiting",
        },
        options: {
          executionMetadata: { audit: { label: "original" } },
          idempotencyKey: "original-key",
        },
      };

      const account = transformedEmailLayer(
        suppliedEmailLayer((submission) =>
          Ref.update(submitted, (sent) => [...sent, submission.message]).pipe(Effect.as(receipt)),
        ),
        ({ message: input, options }) =>
          Effect.gen(function* transformWaitingEmail() {
            yield* Ref.update(transforms, (subjects) => [...subjects, input.subject]);

            if (input.subject === "waiting") {
              yield* Deferred.succeed(entered, true);
              yield* Deferred.await(release);
              assert.deepStrictEqual(options.executionMetadata, { audit: { label: "original" } });
              assert.strictEqual(options.idempotencyKey, "original-key");
            }

            return { ...input, subject: `${input.subject} transformed` };
          }),
      );

      yield* Effect.gen(function* inspectOwnedStreamInputs() {
        const fiber = yield* sendEmailStream(
          Stream.make({ message: { ...message, subject: "first" } }, waiting),
          { concurrency: 2 },
        ).pipe(Stream.runCollect, Effect.forkScoped);

        yield* Deferred.await(entered);
        waiting.message.subject = "mutated";
        attachment.contentBase64 = "Ag==";
        waiting.options.executionMetadata.audit.label = "mutated";
        waiting.options.idempotencyKey = "mutated-key";
        yield* Deferred.succeed(release, true);
        const outcomes = yield* Fiber.join(fiber);
        assert.deepStrictEqual(
          outcomes.map((outcome) => outcome.index),
          [0, 1],
        );
        assert(outcomes.every((outcome) => Result.isSuccess(outcome.result)));
        assert.deepStrictEqual(yield* Ref.get(transforms), ["first", "waiting"]);
        const sent = yield* Ref.get(submitted);
        assert.deepStrictEqual(
          sent.map((input) => input.subject),
          ["first transformed", "waiting transformed"],
        );
        assert.strictEqual(sent[1]?.attachments?.[0].contentBase64, "AQ==");
      }).pipe(Effect.provide(account));
    }),
  );

  it.effect("qualifies preparation failures like sendAll", () =>
    Effect.gen(function* qualifyStreamPreparation() {
      const invalid = new EmailInvalidMessage({
        issues: [{ path: "subject", problem: "unsupported" }],
      });

      const result = yield* sendEmailStream(Stream.make({ message })).pipe(
        Stream.runCollect,
        Effect.provide(
          suppliedEmailLayer(
            () => Effect.succeed(receipt),
            () => Effect.fail(invalid),
          ),
        ),
      );

      assert.deepStrictEqual(
        result.map((outcome) =>
          Result.match(outcome.result, {
            onFailure: (failure) =>
              failure instanceof EmailInvalidMessage
                ? failure.issues.map((issue) => issue.path)
                : [],
            onSuccess: () => [],
          }),
        ),
        [["message.subject"]],
      );
    }),
  );

  it.effect("preflights every routed candidate for each item before any of its sends", () =>
    Effect.gen(function* preflightStreamRoutes() {
      const submissions = yield* Ref.make<readonly string[]>([]);

      const primary = suppliedEmailLayer((submission) =>
        Ref.update(submissions, (subjects) => [...subjects, submission.message.subject]).pipe(
          Effect.as(receipt),
        ),
      );

      const backup = suppliedEmailLayer(
        () => Effect.succeed(receipt),
        (input) =>
          input.subject === "unsupported"
            ? Effect.fail(
                new EmailInvalidMessage({ issues: [{ path: "subject", problem: "unsupported" }] }),
              )
            : Effect.void,
      );

      const result = yield* sendEmailStream(
        Stream.make(
          { message: { ...message, subject: "unsupported" } },
          { message: { ...message, subject: "supported" } },
        ),
      ).pipe(
        Stream.runCollect,
        Effect.provide(
          emailRouterLayer(
            [
              { layer: primary, name: "primary" },
              { layer: backup, name: "backup" },
            ],
            { fallbacks: ["backup"], primary: "primary" },
          ),
        ),
      );

      assert.deepStrictEqual(
        result.map((outcome) =>
          Result.match(outcome.result, {
            onFailure: (failure) => failure._tag,
            onSuccess: (success) => success._tag,
          }),
        ),
        ["EmailInvalidMessage", "Recorded"],
      );
      assert.deepStrictEqual(yield* Ref.get(submissions), ["supported"]);
    }),
  );

  it.effect("retains upstream failures in the stream error channel after earlier outcomes", () =>
    Effect.gen(function* preserveUpstreamStreamError() {
      const failure = new EmailInvalidOptions({
        issues: [{ path: "source", problem: "unavailable" }],
      });

      const indexes = yield* Ref.make<readonly number[]>([]);

      const result = yield* sendEmailStream(
        Stream.make({ message }).pipe(Stream.concat(Stream.fail(failure))),
        { concurrency: 1 },
      ).pipe(
        Stream.tap((outcome) => Ref.update(indexes, (current) => [...current, outcome.index])),
        Stream.runCollect,
        Effect.flip,
        Effect.provide(recordingEmailLayer),
      );

      assert.strictEqual(result, failure);
      assert.deepStrictEqual(yield* Ref.get(indexes), [0]);
    }),
  );

  it.effect("closes the source and interrupts pending sends when a consumer stops early", () =>
    Effect.gen(function* cancelEmailStream() {
      const input = yield* Queue.unbounded<EmailSendRequest>();
      const started = yield* Queue.unbounded<string>();
      const releaseFirst = yield* Deferred.make<true>();
      const sourceClosed = yield* Deferred.make<true>();
      const pendingClosed = yield* Deferred.make<boolean>();

      const source = Stream.fromQueue(input).pipe(
        Stream.ensuring(Deferred.succeed(sourceClosed, true)),
      );

      const account = suppliedEmailLayer((submission) =>
        Effect.gen(function* submitCancelableStreamItem() {
          yield* Queue.offer(started, submission.message.subject);

          if (submission.message.subject === "first") {
            yield* Deferred.await(releaseFirst);

            return receipt;
          }

          return yield* Effect.never.pipe(
            Effect.onExit((exit) => Deferred.succeed(pendingClosed, Exit.hasInterrupts(exit))),
          );
        }),
      );

      const fiber = yield* sendEmailStream(source, { concurrency: 2 }).pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.provide(account),
        Effect.forkScoped,
      );

      yield* Queue.offer(input, { message: { ...message, subject: "first" } });
      yield* Queue.offer(input, { message: { ...message, subject: "pending" } });
      assert.deepStrictEqual(
        [yield* Queue.take(started), yield* Queue.take(started)],
        ["first", "pending"],
      );
      yield* Deferred.succeed(releaseFirst, true);
      const result = yield* Fiber.join(fiber);
      assert.deepStrictEqual(result, [{ index: 0, result: Result.succeed(receipt) }]);
      yield* Deferred.await(sourceClosed);
      assert.strictEqual(yield* Deferred.await(pendingClosed), true);
    }),
  );

  for (const stage of ["prepare", "send"] as const) {
    for (const secondary of ["defect", "interrupt", "failure"] as const) {
      it.effect(
        `preserves compound ${secondary} causes during ${stage} instead of settling an item`,
        () =>
          Effect.gen(function* preserveCompoundStreamCause() {
            const failure = new EmailRejected({ provider: "fixture", reason: "authentication" });
            const defect = new Error("Fictional private stream defect");

            const extra = Match.value(secondary).pipe(
              Match.when("defect", () => Cause.die(defect)),
              Match.when("interrupt", () => Cause.interrupt(123)),
              Match.orElse(() =>
                Cause.fail(new EmailRejected({ provider: "fixture", reason: "rate-limited" })),
              ),
            );

            const cause = Cause.combine(Cause.fail(failure), extra);
            const base = suppliedEmailLayer(() => Effect.succeed(receipt));

            const account = Layer.effect(
              Email,
              Effect.gen(function* acquireFailingStreamOperation() {
                const email = yield* Email;

                return Email.of({
                  ...email,
                  prepare: (input, options) =>
                    stage === "prepare"
                      ? Effect.failCause(cause)
                      : email.prepare(input, options).pipe(
                          Effect.map((operation) => ({
                            ...operation,
                            send: Effect.failCause(cause),
                          })),
                        ),
                });
              }),
            ).pipe(Layer.provide(base));

            const exit = yield* sendEmailStream(Stream.make({ message })).pipe(
              Stream.runCollect,
              Effect.exit,
              Effect.provide(account),
            );

            assert(Exit.isFailure(exit));
            assert(Exit.hasDies(exit));

            const retained = exit.cause.reasons
              .filter(Cause.isDieReason)
              .map((reason) => reason.defect)
              .find(Cause.isCause);

            assert(Cause.isCause(retained));
            assert.deepStrictEqual(
              retained.reasons.map((reason) => reason._tag),
              cause.reasons.map((reason) => reason._tag),
            );
            assert.deepStrictEqual(
              retained.reasons.filter(Cause.isFailReason).map((reason) => reason.error),
              cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error),
            );

            if (secondary === "defect") {
              assert(
                exit.cause.reasons.some(
                  (reason) => Cause.isDieReason(reason) && reason.defect === defect,
                ),
              );
            }

            if (secondary === "interrupt") {
              assert(Exit.hasInterrupts(exit));
            }
          }),
      );
    }
  }

  for (const fault of ["defect", "interrupt"] as const) {
    it.effect(`preserves observer ${fault} after submission as a stream cause`, () =>
      Effect.gen(function* preserveStreamObserverFault() {
        const committed = yield* Ref.make(0);
        const defect = new Error("Fictional private observer defect");

        const account = observedEmailOperationLayer(
          suppliedEmailLayer(() => Ref.update(committed, (n) => n + 1).pipe(Effect.as(receipt))),
          () => (fault === "defect" ? Effect.die(defect) : Effect.failCause(Cause.interrupt(123))),
        );

        const exit = yield* sendEmailStream(Stream.make({ message })).pipe(
          Stream.runCollect,
          Effect.exit,
          Effect.provide(account),
        );

        assert.strictEqual(yield* Ref.get(committed), 1);
        assert(Exit.isFailure(exit));

        if (fault === "defect") {
          assert(
            exit.cause.reasons.some(
              (reason) => Cause.isDieReason(reason) && reason.defect === defect,
            ),
          );
        } else {
          assert(Exit.hasInterrupts(exit));
        }
      }),
    );
  }
});
