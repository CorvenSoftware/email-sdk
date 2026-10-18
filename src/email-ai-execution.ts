import { Cause, Effect, Fiber, Match } from "effect";
import type { Scope } from "effect";
import type { EmailAgentInput, IEmailAgent } from "./email-agent.js";
import type { EmailAiReceipt } from "./email-ai-receipt.js";
import { EmailAiToolError } from "./email-ai-tool-error.js";

const emailAiFailureCause = <E>(cause: Cause.Cause<E>): Cause.Cause<EmailAiToolError> =>
  Cause.fromReasons(
    cause.reasons.map((reason) =>
      Match.value(reason).pipe(
        Match.tag("Die", () => Cause.makeDieReason(new EmailAiToolError({ reason: "defect" }))),
        Match.tag("Fail", () =>
          Cause.makeFailReason(new EmailAiToolError({ reason: "not-completed" })),
        ),
        Match.tag("Interrupt", () => Cause.makeInterruptReason()),
        Match.exhaustive,
      ),
    ),
  );

export const executeEmailAgentTool = (
  agent: IEmailAgent,
  input: EmailAgentInput,
  scope: Scope.Scope,
): Effect.Effect<EmailAiReceipt, EmailAiToolError> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* runScopedEmailAiSubmission() {
      const fiber = yield* Effect.forkIn(agent.submit(input), scope, {
        uninterruptible: false,
      });

      return yield* restore(Fiber.join(fiber)).pipe(Effect.ensuring(Fiber.interrupt(fiber)));
    }),
  ).pipe(
    Effect.map((receipt) => Object.freeze({ receiptKind: receipt._tag })),
    Effect.catchCause((cause) => Effect.failCause(emailAiFailureCause(cause))),
  );
