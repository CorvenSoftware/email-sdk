import { assert, describe, it } from "@effect/vitest";
import { Cause, Deferred, Duration, Effect, Exit, Fiber, Layer, Ref, Schema } from "effect";
import {
  explainEmailRoutePlan,
  EmailRouteCompatibilitySchema,
  EmailRoutePlanExplanationSchema,
} from "./email-routing-diagnostics.js";
import { EmailInvalidMessage } from "./email-invalid-message.js";
import { EmailInvalidOptions } from "./email-invalid-options.js";
import type { EmailMessage, EmailMessageInput } from "./email-message.js";
import type { EmailSenderCapabilities } from "./email-capabilities.js";
import { EmailRouter, emailRouterLayer } from "./email-routing.js";
import { EmailSender, EmailSenderIdempotencySchema } from "./email-sender.js";
import { Email, emailLayer } from "./email-service.js";
import { recordingEmailCapabilities } from "./recording-email-sender.js";
import { startEmailTraceFixture } from "../test/email-tracing-fixture.js";

const message: EmailMessageInput = {
  body: { text: "private fictional body" },
  from: "sender@example.test",
  metadata: { context: "private metadata" },
  subject: "private fictional subject",
  to: "recipient@example.test",
};

const candidateLayer = (
  validate: (input: EmailMessage) => Effect.Effect<void, EmailInvalidMessage> = () => Effect.void,
  capabilities: EmailSenderCapabilities = recordingEmailCapabilities,
) =>
  emailLayer().pipe(
    Layer.provide(
      Layer.succeed(EmailSender, {
        capabilities,
        idempotency: EmailSenderIdempotencySchema.cases.KeyForwarding.make({}),
        provider: "fixture",
        submit: () => Effect.die(new Error("Routing explanation invoked sender.submit")),
        validate,
      }),
    ),
  );

const withRouter = <E1, R1, E2, R2>(
  primary: Layer.Layer<Email, E1, R1>,
  backup: Layer.Layer<Email, E2, R2>,
) =>
  emailRouterLayer(
    [
      { layer: primary, name: "primary" },
      { layer: backup, name: "backup" },
    ],
    { primary: "primary" },
  );

const plan = { fallbacks: ["backup"], primary: "primary" } as const;

describe("Non-sending routing diagnostics", () => {
  it.effect("checks every selected candidate in order without exposing inputs or submitting", () =>
    Effect.gen(function* explainRouteCompatibility() {
      const trace = yield* startEmailTraceFixture();
      const checks = yield* Ref.make<readonly string[]>([]);

      const primary = candidateLayer(() => Ref.update(checks, (names) => [...names, "primary"]), {
        ...recordingEmailCapabilities,
        metadata: false,
      });

      const backup = candidateLayer(() => Ref.update(checks, (names) => [...names, "backup"]));

      const explanation = yield* explainEmailRoutePlan(plan, {
        message,
        options: { idempotencyKey: "private-key" },
      }).pipe(Effect.provide(withRouter(primary, backup)), Effect.withTracer(trace.tracer));

      assert.strictEqual(explanation.compatible, false);
      assert.deepStrictEqual(
        explanation.candidates.map((candidate) => [candidate.name, candidate._tag]),
        [
          ["primary", "Incompatible"],
          ["backup", "Compatible"],
        ],
      );
      const [first] = explanation.candidates;
      assert(EmailRouteCompatibilitySchema.guards.Incompatible(first));
      assert(first.failure instanceof EmailInvalidMessage);
      assert.deepStrictEqual(
        first.failure.issues.map((issue) => issue.path),
        ["metadata"],
      );
      assert.deepStrictEqual(yield* Ref.get(checks), ["backup"]);
      assert(Schema.is(EmailRoutePlanExplanationSchema)(explanation));
      assert.isFrozen(explanation);
      assert.isFrozen(explanation.candidates);
      assert(explanation.candidates.every(Object.isFrozen));

      const encoded = yield* Schema.encodeEffect(
        Schema.fromJsonString(EmailRoutePlanExplanationSchema),
      )(explanation);

      const diagnostics = yield* trace.diagnostics;

      for (const value of ["private", "sender@example.test", "recipient@example.test"]) {
        assert.notInclude(encoded, value);
        assert.notInclude(diagnostics, value);
      }
    }),
  );

  it.effect("reports unregistered candidates without silently dropping them", () =>
    Effect.gen(function* explainUnknownRoute() {
      const explanation = yield* explainEmailRoutePlan(
        { fallbacks: ["missing"], primary: "primary" },
        { message },
      ).pipe(Effect.provide(withRouter(candidateLayer(), candidateLayer())));

      assert.strictEqual(explanation.compatible, false);
      assert.deepStrictEqual(
        explanation.candidates.map((candidate) => candidate._tag),
        ["Compatible", "Incompatible"],
      );
      const [, missing] = explanation.candidates;
      assert.isDefined(missing);
      assert(EmailRouteCompatibilitySchema.guards.Incompatible(missing));
      assert(missing.failure instanceof EmailInvalidOptions);
    }),
  );

  it.effect("reports native-audience candidates without preparing or submitting them", () =>
    Effect.gen(function* explainNativeAudienceIncompatibility() {
      const nativeChecks = yield* Ref.make(0);

      const native = Layer.effect(
        Email,
        Email.useSync((email) =>
          Email.of({
            ...email,
            personalization: "NativeAudience",
          }),
        ),
      ).pipe(Layer.provide(candidateLayer(() => Ref.update(nativeChecks, (count) => count + 1))));

      const explanation = yield* explainEmailRoutePlan(plan, { message }).pipe(
        Effect.provide(withRouter(candidateLayer(), native)),
      );

      const [primary, backup] = explanation.candidates;
      assert(primary !== undefined && backup !== undefined);
      assert(EmailRouteCompatibilitySchema.guards.Compatible(primary));
      assert(EmailRouteCompatibilitySchema.guards.Incompatible(backup));
      assert(backup.failure instanceof EmailInvalidOptions);
      assert(backup.failure.issues.some((issue) => issue.path === "personalization"));
      assert.strictEqual(explanation.compatible, false);
      assert.strictEqual(yield* Ref.get(nativeChecks), 0);
    }),
  );

  it.effect("rejects malformed plans and requests before invoking candidate preparation", () =>
    Effect.gen(function* rejectInvalidExplanationInput() {
      const checks = yield* Ref.make(0);
      const candidate = candidateLayer(() => Ref.update(checks, (count) => count + 1));
      const router = withRouter(candidate, candidate);

      const invalidPlan = yield* explainEmailRoutePlan(
        { fallbacks: ["primary"], primary: "primary" },
        { message },
      ).pipe(Effect.provide(router), Effect.flip);

      assert(invalidPlan instanceof EmailInvalidOptions);

      const invalidMessage = yield* explainEmailRoutePlan(plan, {
        message: { ...message, subject: "invalid\nsubject" },
      }).pipe(Effect.provide(router), Effect.flip);

      assert(invalidMessage instanceof EmailInvalidMessage);

      const invalidOptions = yield* explainEmailRoutePlan(plan, {
        message,
        options: { idempotencyKey: "private invalid key" },
      }).pipe(Effect.provide(router), Effect.flip);

      assert(invalidOptions instanceof EmailInvalidOptions);
      assert.strictEqual(yield* Ref.get(checks), 0);
    }),
  );

  it.effect("owns the plan and complete request before suspended preparation", () =>
    Effect.gen(function* ownRoutingExplanationInputs() {
      const entered = yield* Deferred.make<true>();
      const release = yield* Deferred.make<true>();
      const bodies = yield* Ref.make<readonly string[]>([]);

      const primary = candidateLayer((input) =>
        Ref.update(bodies, (values) => [...values, input.body.text ?? ""]).pipe(
          Effect.andThen(Deferred.succeed(entered, true)),
          Effect.andThen(Deferred.await(release)),
          Effect.asVoid,
        ),
      );

      const backup = candidateLayer((input) =>
        Ref.update(bodies, (values) => [...values, input.body.text ?? ""]),
      );

      const fallbacks: [string, ...string[]] = ["backup"];
      const mutablePlan = { fallbacks, primary: "primary" };
      const body = { text: "Original fictional content" };

      const policy = {
        deadline: Duration.seconds(5),
        initialDelay: Duration.millis(1),
        maxAttempts: 1,
      };

      const fiber = yield* explainEmailRoutePlan(mutablePlan, {
        message: { ...message, body },
        options: { policy },
      }).pipe(Effect.provide(withRouter(primary, backup)), Effect.forkScoped);

      yield* Deferred.await(entered);
      mutablePlan.primary = "missing";
      fallbacks[0] = "missing";
      body.text = "Changed fictional content";
      policy.maxAttempts = 0;
      yield* Deferred.succeed(release, true);
      const explanation = yield* Fiber.join(fiber);
      assert.strictEqual(explanation.compatible, true);
      assert.deepStrictEqual(
        explanation.candidates.map((candidate) => candidate.name),
        ["primary", "backup"],
      );
      assert.deepStrictEqual(yield* Ref.get(bodies), [
        "Original fictional content",
        "Original fictional content",
      ]);
    }),
  );

  for (const fault of ["defect", "interruption", "compound"] as const) {
    it.effect(`preserves a preparation ${fault} instead of reporting incompatibility`, () =>
      Effect.gen(function* preserveExplanationCause() {
        const backupChecks = yield* Ref.make(0);
        const defect = new Error("private routing defect");

        const primary = candidateLayer(() => {
          if (fault === "defect") {
            return Effect.die(defect);
          }

          if (fault === "interruption") {
            return Effect.failCause(Cause.interrupt(418));
          }

          return Effect.failCause(
            Cause.combine(
              Cause.fail(
                new EmailInvalidMessage({ issues: [{ path: "body", problem: "Invalid content" }] }),
              ),
              Cause.die(defect),
            ),
          );
        });

        const backup = candidateLayer(() => Ref.update(backupChecks, (count) => count + 1));

        const exit = yield* explainEmailRoutePlan(plan, { message }).pipe(
          Effect.provide(withRouter(primary, backup)),
          Effect.exit,
        );

        assert(Exit.isFailure(exit));

        if (fault === "interruption") {
          assert(Exit.hasInterrupts(exit));
        } else {
          assert(
            exit.cause.reasons.some(
              (reason) => Cause.isDieReason(reason) && reason.defect === defect,
            ),
          );
        }

        assert.strictEqual(yield* Ref.get(backupChecks), 0);
      }),
    );
  }

  it.effect("offers lazy router accessors without changing default-plan selection", () =>
    Effect.gen(function* useRouterAccessors() {
      const routes = yield* EmailRouter.routes;
      assert.deepStrictEqual(
        routes.map((route) => route.name),
        ["primary", "backup"],
      );
      const route = yield* EmailRouter.select();
      const explanation = yield* route.prepare(message);
      assert.strictEqual(explanation.previews.length, 1);
      assert.deepStrictEqual(explanation.previews[0].routes.map(String), ["primary"]);
    }).pipe(Effect.provide(withRouter(candidateLayer(), candidateLayer()))),
  );
});
