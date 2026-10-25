import { assert, describe, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Ref, Result } from "effect";
import { makeScriptedEmailSender } from "../test/email-scripted-sender-fixture.js";
import { Email, emailLayerFromSender } from "./email-service.js";
import { EmailReceiptSchema } from "./email-message.js";
import { EmailRejected } from "./email-rejected.js";
import { EmailSender } from "./email-sender.js";
import {
  RecordedEmails,
  recordingEmailLayer,
  recordingSenderLayer,
} from "./recording-email-sender.js";

const message = {
  body: { text: "Fictional notification." },
  from: "sender@example.test",
  subject: "Fictional order ready",
  to: "recipient@example.test",
};

const receipt = EmailReceiptSchema.cases.Recorded.make({ sequence: 1 });

describe("Effect-native Email accessors", () => {
  it.effect("resolves the current service lazily for each execution of the same operation", () =>
    Effect.gen(function* resolveEmailAtExecution() {
      const operation = Email.send(message);
      const rejected = new EmailRejected({ provider: "scripted", reason: "authentication" });
      const first = yield* makeScriptedEmailSender([Effect.succeed(receipt)]);
      const second = yield* makeScriptedEmailSender([Effect.fail(rejected)]);
      assert.strictEqual((yield* first.attempts).length, 0);
      assert.strictEqual((yield* second.attempts).length, 0);
      assert.deepStrictEqual(
        yield* operation.pipe(Effect.provide(emailLayerFromSender(first.layer))),
        receipt,
      );

      const failure = yield* operation.pipe(
        Effect.provide(emailLayerFromSender(second.layer)),
        Effect.flip,
      );

      assert.strictEqual(failure, rejected);
      assert.strictEqual((yield* first.attempts).length, 1);
      assert.strictEqual((yield* second.attempts).length, 1);
    }),
  );

  it.effect("validates and prepares without sending, then submits the same owned preview", () =>
    Effect.gen(function* prepareWithEmailAccessors() {
      const records = yield* RecordedEmails;
      const input = { ...message, body: { text: "Original fictional content" } };
      const validated = yield* Email.validate(input);
      const prepared = yield* Email.prepare(input);
      assert.strictEqual(validated.body.text, "Original fictional content");
      assert.strictEqual((yield* records.messages).length, 0);
      input.body.text = "Changed content";
      yield* prepared.send;
      const [recorded] = yield* records.messages;
      assert.isDefined(recorded);
      assert.strictEqual(recorded.body.text, "Original fictional content");
      assert.strictEqual(prepared.previews[0].message.body.text, "Original fictional content");
      assert.strictEqual(yield* Email.personalization, "Individual");
      assert.strictEqual((yield* Email.capabilities).attachments, true);
    }).pipe(Effect.provide(recordingEmailLayer)),
  );

  it.effect(
    "settles expected batch failures and renders personalized recipients through the service",
    () =>
      Effect.gen(function* sendThroughEmailAccessors() {
        const outcomes = yield* Email.sendAll([
          { message },
          { message: { ...message, subject: "invalid\nsubject" } },
        ]);

        assert.strictEqual(outcomes.length, 2);
        const [sent, invalid] = outcomes;
        assert.isDefined(sent);
        assert.isDefined(invalid);
        assert(Result.isSuccess(sent));
        assert(Result.isFailure(invalid));
        assert.strictEqual(invalid.failure._tag, "EmailInvalidMessage");

        const personalized = yield* Email.sendPersonalized({
          message: {
            body: { text: "Hello %recipient.name%" },
            from: message.from,
            subject: "Welcome",
          },
          recipients: [{ to: "second@example.test", variables: { name: "Fictional Person" } }],
        });

        assert.strictEqual(personalized.length, 1);
        const [personalizedResult] = personalized;
        assert.isDefined(personalizedResult);
        assert(Result.isSuccess(personalizedResult));
        const records = yield* (yield* RecordedEmails).messages;
        assert.deepStrictEqual(
          records.map((entry) => entry.body.text),
          ["Fictional notification.", "Hello Fictional Person"],
        );
      }).pipe(Effect.provide(recordingEmailLayer)),
  );

  it.effect(
    "shares one scoped sender acquisition and closes it after the application operation",
    () =>
      Effect.gen(function* ownEmailLayerResources() {
        const acquired = yield* Ref.make(0);
        const released = yield* Ref.make(0);

        const sender = yield* makeScriptedEmailSender([
          Effect.succeed(receipt),
          Effect.succeed(receipt),
        ]);

        const scoped = Layer.effect(
          EmailSender,
          Effect.acquireRelease(
            EmailSender.pipe(Effect.tap(() => Ref.update(acquired, (count) => count + 1))),
            () => Ref.update(released, (count) => count + 1),
          ),
        ).pipe(Layer.provide(sender.layer));

        const account = emailLayerFromSender(scoped);
        assert.strictEqual(yield* Ref.get(acquired), 0);
        yield* Effect.all([Email.send(message), Email.send(message)], { concurrency: 2 }).pipe(
          Effect.provide(account),
        );
        assert.strictEqual(yield* Ref.get(acquired), 1);
        assert.strictEqual(yield* Ref.get(released), 1);
        assert.strictEqual((yield* sender.attempts).length, 2);
      }),
  );

  it.effect.each(["defect", "interruption"] as const)(
    "preserves a submission %s without settling or replaying it",
    (fault) =>
      Effect.gen(function* preserveAccessorCauses() {
        const defect = new Error("private accessor defect");

        const sender = yield* makeScriptedEmailSender([
          fault === "defect" ? Effect.die(defect) : Effect.failCause(Cause.interrupt(417)),
          Effect.succeed(receipt),
        ]);

        const exit = yield* Email.send(message).pipe(
          Effect.provide(emailLayerFromSender(sender.layer)),
          Effect.exit,
        );

        assert(Exit.isFailure(exit));
        assert.strictEqual((yield* sender.attempts).length, 1);

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

  it.effect("accepts the existing recording sender Layer without a new implementation", () =>
    Email.send(message).pipe(
      Effect.provide(emailLayerFromSender(recordingSenderLayer)),
      Effect.tap((recorded) =>
        Effect.sync(() => {
          assert.strictEqual(recorded._tag, "Recorded");
        }),
      ),
    ),
  );
});
