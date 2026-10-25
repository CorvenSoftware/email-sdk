import { assert, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import type { EmailInputIssue } from "./email-input-issues.js";
import { EmailInvalidMessage } from "./email-invalid-message.js";
import { EmailInvalidOptions } from "./email-invalid-options.js";
import { emailPreparedOperations } from "./email-prepared-operation.js";
import { EmailRejected } from "./email-rejected.js";
import {
  EmailRouteCompatibilitySchema,
  EmailRoutePlanExplanationSchema,
  explainEmailRoutePlan,
} from "./email-routing-diagnostics.js";
import { emailRouterLayer } from "./email-routing.js";
import { Email } from "./email-service.js";
import { recordingEmailCapabilities } from "./recording-email-sender.js";

const failureCases: readonly {
  readonly name: string;
  readonly make: (
    issues: readonly EmailInputIssue[],
  ) => EmailInvalidMessage | EmailInvalidOptions | EmailRejected;
}[] = [
  { make: (issues) => new EmailInvalidMessage({ issues }), name: "message" },
  { make: (issues) => new EmailInvalidOptions({ issues }), name: "options" },
  {
    make: () =>
      new EmailRejected({
        provider: "synthetic",
        providerCode: 451,
        reason: "temporarily-unavailable",
        retryAfterMillis: 27,
        status: 503,
      }),
    name: "rejection",
  },
];

for (const example of failureCases) {
  it.effect(`snapshots ${example.name} failures without private causes or caller mutation`, () =>
    Effect.gen(function* inspectPrivatePreparationFailure() {
      const issue = { path: "body", problem: "A required feature is unsupported" };
      const issues = [issue];
      const failure = example.make(issues);
      const privatePayload = "private-diagnostic-payload";
      Object.assign(failure, {
        cause: { response: privatePayload },
        providerResponse: privatePayload,
      });

      const account = Layer.succeed(
        Email,
        Email.of({
          capabilities: recordingEmailCapabilities,
          ...emailPreparedOperations(() => Effect.fail(failure)),
        }),
      );

      const explanation = yield* explainEmailRoutePlan(
        { primary: "primary" },
        {
          message: {
            body: { text: "A fictional notification." },
            from: "sender@example.test",
            subject: "Local compatibility",
            to: "recipient@example.test",
          },
        },
      ).pipe(
        Effect.provide(
          emailRouterLayer([{ layer: account, name: "primary" }], { primary: "primary" }),
        ),
      );

      const [candidate] = explanation.candidates;
      assert(candidate !== undefined);
      assert.equal(explanation.compatible, false);
      const codec = Schema.fromJsonString(EmailRoutePlanExplanationSchema);
      const serialized = JSON.stringify(explanation);
      assert(!serialized.includes(privatePayload));
      assert(EmailRouteCompatibilitySchema.guards.Incompatible(candidate));
      assert.notStrictEqual(candidate.failure, failure);
      assert(Object.isFrozen(candidate.failure));
      assert(!Object.hasOwn(candidate.failure, "cause"));
      assert(!Object.hasOwn(candidate.failure, "providerResponse"));
      assert(!Object.isFrozen(failure));
      assert(!Object.isFrozen(issues));

      if (
        Schema.is(EmailInvalidMessage)(candidate.failure) ||
        Schema.is(EmailInvalidOptions)(candidate.failure)
      ) {
        assert(Object.isFrozen(candidate.failure.issues));
        assert(candidate.failure.issues.every(Object.isFrozen));
      }

      if (Schema.is(EmailRejected)(candidate.failure)) {
        assert.equal(candidate.failure.providerCode, 451);
        assert.equal(candidate.failure.status, 503);
        assert.equal(candidate.failure.retryAfterMillis, 27);
      }

      issue.problem = "Changed after diagnosis";
      issues.push({ path: "subject", problem: "Added after diagnosis" });
      Object.assign(failure, { reason: "authentication", status: 401 });
      assert.equal(JSON.stringify(explanation), serialized);
      const encoded = yield* Schema.encodeEffect(codec)(explanation);
      assert(!encoded.includes(privatePayload));
    }),
  );
}
