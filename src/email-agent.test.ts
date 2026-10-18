import { assert, describe, it } from "@effect/vitest";
import {
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Queue,
  Predicate,
  Redacted,
  Ref,
  Result,
  Schema,
} from "effect";
import { TestClock } from "effect/testing";
import { emailFixtureClientLayer, startEmailHttpFixture } from "../test/email-http-fixture.js";
import { startEmailTraceFixture } from "../test/email-tracing-fixture.js";
import {
  EmailAgent,
  EmailAgentApproval,
  EmailAgentApprovalError,
  emailAgentLayer,
} from "./email-agent.js";
import type { EmailAgentProposal, IEmailAgentApproval } from "./email-agent.js";
import { formatEmailMailbox } from "./email-address.js";
import { EmailConfigurationError } from "./email-configuration-error.js";
import { defaultedEmailLayer } from "./email-defaults.js";
import { EmailDeliveryUnknown } from "./email-delivery-unknown.js";
import { EmailInvalidMessage } from "./email-invalid-message.js";
import { EmailInvalidOptions } from "./email-invalid-options.js";
import { EmailRejected } from "./email-rejected.js";
import { EmailSender, EmailSenderIdempotencySchema } from "./email-sender.js";
import type { EmailSubmission } from "./email-sender.js";
import { emailLayer } from "./email-service.js";
import { emailRouterLayer } from "./email-routing.js";
import { transformedEmailLayer } from "./email-transformation.js";
import { postmarkEmailLayer } from "./postmark-email-sender.js";
import { mailersendEmailLayer } from "./mailersend-email-sender.js";
import { EmailReceiptSchema } from "./email-message.js";
import type { EmailReceipt } from "./email-message.js";
import {
  RecordedEmails,
  recordingEmailLayer,
  recordingSenderLayer,
  recordingEmailCapabilities,
} from "./recording-email-sender.js";

const input = {
  body: { text: "Fictional private body" },
  subject: "Fictional private subject",
  to: "recipient@example.test",
};

const from = { address: "host@example.test", name: "Host" };

const approvalLayer = (review: IEmailAgentApproval["review"]) =>
  Layer.succeed(EmailAgentApproval, EmailAgentApproval.of({ review }));

const recordingAgentLayer = (review: IEmailAgentApproval["review"]) =>
  emailAgentLayer({ from }).pipe(
    Layer.provide(approvalLayer(review)),
    Layer.provideMerge(recordingEmailLayer),
  );

const policy = {
  deadline: Duration.seconds(10),
  initialDelay: Duration.millis(100),
  maxAttempts: 2,
};

describe("host-approved agent email operations", () => {
  it.effect.each(["Rejected", "Unknown"] as const)(
    "reviews every effective route once and preserves %s routing authority after approval",
    (mode) =>
      Effect.gen(function* reviewPreparedRouteCandidates() {
        const proposals = yield* Queue.unbounded<EmailAgentProposal>();
        const submitted = yield* Queue.unbounded<EmailSubmission>();
        const release = yield* Deferred.make<boolean>();
        const primaryOrdinal = yield* Ref.make(0);
        const backupOrdinal = yield* Ref.make(0);
        const context = { tenant: "private-original-tenant" };

        const outcome = {
          Rejected: Effect.fail(
            new EmailRejected({ provider: "fixture", reason: "authentication" }),
          ),
          Unknown: Effect.fail(
            new EmailDeliveryUnknown({ provider: "fixture", reason: "transport" }),
          ),
        };

        const route = (
          name: string,
          ordinal: Ref.Ref<number>,
          result: Effect.Effect<EmailReceipt, EmailRejected | EmailDeliveryUnknown>,
        ) =>
          transformedEmailLayer(
            defaultedEmailLayer(
              emailLayer({ ...policy, maxAttempts: 1 }).pipe(
                Layer.provide(
                  Layer.succeed(
                    EmailSender,
                    EmailSender.of({
                      capabilities: recordingEmailCapabilities,
                      idempotency: EmailSenderIdempotencySchema.cases.Native.make({
                        retention: Duration.hours(24),
                      }),
                      provider: "fixture",
                      submit: (submission) =>
                        Queue.offer(submitted, submission).pipe(Effect.andThen(result)),
                      validate: () => Effect.void,
                    }),
                  ),
                ),
              ),
              { headers: [{ name: "X-Route", value: name }], idempotencyKeyPrefix: `${name}/` },
            ),
            ({ message, options }) => {
              const tenant = options.executionMetadata?.tenant;
              assert(Predicate.isString(tenant));

              return Ref.getAndUpdate(ordinal, (value) => value + 1).pipe(
                Effect.map((value) => ({
                  ...message,
                  subject: `${message.subject}/${name}/${value}/${tenant}`,
                })),
              );
            },
          );

        const routes = emailRouterLayer(
          [
            { layer: route("primary", primaryOrdinal, outcome[mode]), name: "primary" },
            {
              layer: route(
                "backup",
                backupOrdinal,
                Effect.succeed(EmailReceiptSchema.cases.Recorded.make({ sequence: 1 })),
              ),
              name: "backup",
            },
          ],
          { fallbacks: ["backup"], primary: "primary" },
        );

        const layer = emailAgentLayer({ from }).pipe(
          Layer.provide(
            approvalLayer((proposal) =>
              Queue.offer(proposals, proposal).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as("Approved" as const),
              ),
            ),
          ),
          Layer.provide(routes),
        );

        yield* Effect.gen(function* approveExactPreparedCandidates() {
          const fiber = yield* (yield* EmailAgent)
            .submit(input, { executionMetadata: context, idempotencyKey: "event" })
            .pipe(Effect.result, Effect.forkScoped);

          const proposal = yield* Queue.take(proposals);
          const [primary, backup] = proposal.previews;
          assert.isDefined(backup);
          assert.strictEqual(proposal.message, primary.message);
          assert.strictEqual(proposal.options.idempotencyKey, "primary/event");
          assert.strictEqual(backup.options.idempotencyKey, "backup/event");
          assert.deepStrictEqual(primary.routes.map(String), ["primary"]);
          assert.deepStrictEqual(backup.routes.map(String), ["backup"]);
          assert.strictEqual(
            primary.message.subject,
            `${input.subject}/primary/0/private-original-tenant`,
          );
          assert.strictEqual(
            backup.message.subject,
            `${input.subject}/backup/0/private-original-tenant`,
          );
          assert.strictEqual(yield* Queue.size(submitted), 0);
          context.tenant = "changed-after-review";
          Reflect.set(backup.message.body, "text", "changed-after-review");
          yield* Deferred.succeed(release, true);
          const result = yield* Fiber.join(fiber);
          const primarySubmission = yield* Queue.take(submitted);
          assert.deepStrictEqual(primarySubmission.message, primary.message);
          assert.strictEqual(primarySubmission.idempotencyKey, primary.options.idempotencyKey);

          if (mode === "Rejected") {
            assert(Result.isSuccess(result));
            const backupSubmission = yield* Queue.take(submitted);
            assert.deepStrictEqual(backupSubmission.message, backup.message);
            assert.strictEqual(backupSubmission.idempotencyKey, backup.options.idempotencyKey);
          } else {
            assert(Result.isFailure(result));
            assert(result.failure instanceof EmailDeliveryUnknown);
          }

          assert.strictEqual(yield* Queue.size(submitted), 0);
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped),
  );

  it.effect(
    "rejects unsupported transformed fallback intent before approval or any provider submission",
    () =>
      Effect.gen(function* preflightTransformedFallbackBeforeApproval() {
        const fixture = yield* startEmailHttpFixture({ body: "{}", status: 200 });
        const reviews = yield* Queue.unbounded<EmailAgentProposal>();

        const provider = postmarkEmailLayer({
          serverToken: Redacted.make("fictional-unused-key"),
        }).pipe(Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.postmarkapp.com")));

        const routes = emailRouterLayer(
          [
            { layer: provider, name: "primary" },
            {
              layer: transformedEmailLayer(provider, ({ message }) =>
                Effect.succeed({ ...message, sendAt: "2099-01-01T00:00:00Z" }),
              ),
              name: "backup",
            },
          ],
          { fallbacks: ["backup"], primary: "primary" },
        );

        const result = yield* EmailAgent.pipe(
          Effect.flatMap((agent) => agent.submit(input)),
          Effect.provide(
            emailAgentLayer({ from }).pipe(
              Layer.provide(
                approvalLayer((proposal) =>
                  Queue.offer(reviews, proposal).pipe(Effect.as("Approved" as const)),
                ),
              ),
              Layer.provide(routes),
            ),
          ),
          Effect.result,
        );

        assert(Result.isFailure(result));
        assert(result.failure instanceof EmailInvalidMessage);
        assert.strictEqual(yield* Queue.size(reviews), 0);
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "reviews the effective defaults then sends original intent once, returning the original receipt",
    () =>
      Effect.gen(function* verifyApprovedEffectiveIntent() {
        const reviewed = yield* Queue.unbounded<EmailAgentProposal>();

        const base = defaultedEmailLayer(recordingEmailLayer, {
          headers: [{ name: "X-Host", value: "private-default-header" }],
          idempotencyKeyPrefix: "host/",
          metadata: { source: "host" },
          replyTo: "reply@example.test",
        });

        const agentLayer = emailAgentLayer({ from }).pipe(
          Layer.provide(
            approvalLayer((proposal) =>
              Queue.offer(reviewed, proposal).pipe(Effect.as("Approved" as const)),
            ),
          ),
          Layer.provideMerge(base),
          Layer.provideMerge(recordingSenderLayer),
        );

        const app = Effect.gen(function* sendApprovedDefaultedIntent() {
          const agent = yield* EmailAgent;
          const first = yield* agent.submit(input, { idempotencyKey: "event" });
          const [recorded] = yield* (yield* RecordedEmails).messages;
          const proposal = yield* Queue.take(reviewed);
          assert.isDefined(recorded);
          assert.deepStrictEqual(recorded, proposal.message);
          assert.strictEqual(recorded.headers?.length, 1);
          assert.strictEqual(recorded.headers?.[0].value, "private-default-header");
          assert.deepStrictEqual(recorded.from, proposal.message.from);
          const repeated = yield* agent.submit(input, { idempotencyKey: "event" });
          assert.strictEqual(first, repeated);
          assert.strictEqual(first._tag, "Recorded");
          assert.strictEqual(yield* Queue.size(reviewed), 1);
          assert(Object.isFrozen(proposal));
          assert(Object.isFrozen(proposal.options));
          assert(Object.isFrozen(proposal.message.body));
        });

        yield* app.pipe(Effect.provide(agentLayer));
      }),
  );

  it.effect("declines without submitting and does not memoize approval across calls", () =>
    Effect.gen(function* verifyFreshApprovalForEveryOperation() {
      const attempts = yield* Ref.make(0);

      const app = Effect.gen(function* requestApprovalTwice() {
        const agent = yield* EmailAgent;
        const first = yield* agent.submit(input);
        const second = yield* Effect.result(agent.submit(input));
        assert.strictEqual(first._tag, "Recorded");
        assert(Result.isFailure(second));
        assert(second.failure instanceof EmailAgentApprovalError);
        assert.strictEqual(second.failure.reason, "declined");
        assert.strictEqual((yield* (yield* RecordedEmails).messages).length, 1);
      });

      yield* app.pipe(
        Effect.provide(
          recordingAgentLayer(() =>
            Ref.updateAndGet(attempts, (count) => count + 1).pipe(
              Effect.map((count) => (count === 1 ? "Approved" : "Declined")),
            ),
          ),
        ),
      );
    }),
  );

  it.effect.each([
    "from",
    "cc",
    "bcc",
    "replyTo",
    "headers",
    "metadata",
    "sendAt",
    "provider",
    "adapter",
    "idempotencyKey",
    "approved",
  ])("refuses model-controlled %s before asking for approval", (field) =>
    Effect.gen(function* verifyModelAuthorityFence() {
      const reviews = yield* Ref.make(0);
      const malicious = { ...input };
      Reflect.set(malicious, field, "private-attempted-control");

      const app = Effect.gen(function* refuseUnsupportedModelControl() {
        const result = yield* Effect.result((yield* EmailAgent).submit(malicious));
        assert(Result.isFailure(result));
        assert(result.failure instanceof EmailInvalidMessage);
        assert.notInclude(JSON.stringify(result.failure), "private-attempted-control");
        assert.strictEqual(yield* Ref.get(reviews), 0);
        assert.strictEqual((yield* (yield* RecordedEmails).messages).length, 0);
      });

      yield* app.pipe(
        Effect.provide(
          recordingAgentLayer(() =>
            Ref.update(reviews, (count) => count + 1).pipe(Effect.as("Approved" as const)),
          ),
        ),
      );
    }),
  );

  it.effect("owns sender, message, and host policy/key while approval is pending", () =>
    Effect.gen(function* verifyPendingApprovalOwnership() {
      const proposals = yield* Queue.unbounded<EmailAgentProposal>();
      const release = yield* Deferred.make<boolean>();
      const configuration = { from: { ...from } };
      const mutable = { ...input, body: { text: input.body.text } };
      const options = { idempotencyKey: "private-host-key", policy: { ...policy } };

      const review: IEmailAgentApproval["review"] = (proposal) =>
        Queue.offer(proposals, proposal).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as("Approved" as const),
        );

      const app = Effect.gen(function* approveOriginalOwnedIntent() {
        const agent = yield* EmailAgent;
        configuration.from.address = "changed@example.test";
        const fiber = yield* agent.submit(mutable, options).pipe(Effect.forkScoped);
        const proposal = yield* Queue.take(proposals);
        mutable.subject = "changed";
        mutable.body.text = "changed";
        mutable.to = "changed@example.test";
        options.idempotencyKey = "changed";
        options.policy.maxAttempts = 6;
        Reflect.set(proposal.message.body, "text", "changed");
        Reflect.set(proposal.options, "idempotencyKey", "changed");
        assert.strictEqual(proposal.message.subject, input.subject);
        assert.strictEqual(proposal.message.body.text, input.body.text);
        assert.strictEqual(formatEmailMailbox(proposal.message.from), '"Host" <host@example.test>');
        assert.strictEqual(proposal.options.idempotencyKey, "private-host-key");
        assert.strictEqual(proposal.options.policy?.maxAttempts, 2);
        yield* Deferred.succeed(release, true);
        yield* Fiber.join(fiber);
        const [sent] = yield* (yield* RecordedEmails).messages;
        assert.isDefined(sent);
        assert.deepStrictEqual(sent, proposal.message);
      });

      yield* app.pipe(
        Effect.provide(
          emailAgentLayer(configuration).pipe(
            Layer.provide(approvalLayer(review)),
            Layer.provideMerge(recordingEmailLayer),
          ),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("local options and provider restrictions fail before approval or HTTP", () =>
    Effect.gen(function* verifyAgentPreflight() {
      const fixture = yield* startEmailHttpFixture({ body: "{}", status: 500 });
      const reviews = yield* Ref.make(0);

      const provider = postmarkEmailLayer({
        serverToken: Redacted.make("private-fictional-key"),
      }).pipe(Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.postmarkapp.com")));

      const agentLayer = emailAgentLayer({ from }).pipe(
        Layer.provide(
          approvalLayer(() =>
            Ref.update(reviews, (count) => count + 1).pipe(Effect.as("Approved" as const)),
          ),
        ),
        Layer.provide(provider),
      );

      const app = Effect.gen(function* rejectUnreviewableAgentOperation() {
        const agent = yield* EmailAgent;

        const malformed = yield* Effect.result(
          agent.submit(input, { policy: { ...policy, maxAttempts: 0 } }),
        );

        assert(Result.isFailure(malformed));
        assert(malformed.failure instanceof EmailInvalidOptions);

        const unsupported = yield* Effect.result(
          agent.submit(input, { idempotencyKey: "unsupported" }),
        );

        assert(Result.isFailure(unsupported));
        assert(unsupported.failure instanceof EmailRejected);
        assert.strictEqual(unsupported.failure.reason, "unsupported-idempotency");
        assert.strictEqual(yield* Ref.get(reviews), 0);
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      });

      yield* app.pipe(Effect.provide(agentLayer));
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a real provider submits only after approval and reports acceptance rather than delivery",
    () =>
      Effect.gen(function* verifyApprovedProviderWire() {
        const fixture = yield* startEmailHttpFixture({
          body: '{"ErrorCode":0,"MessageID":"fictional-agent-ack"}',
          status: 200,
        });

        const proposals = yield* Queue.unbounded<EmailAgentProposal>();
        const release = yield* Deferred.make<boolean>();

        const provider = postmarkEmailLayer({
          serverToken: Redacted.make("fictional-unused-key"),
        }).pipe(Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.postmarkapp.com")));

        const agentLayer = emailAgentLayer({ from }).pipe(
          Layer.provide(
            approvalLayer((proposal) =>
              Queue.offer(proposals, proposal).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as("Approved" as const),
              ),
            ),
          ),
          Layer.provide(provider),
        );

        const app = Effect.gen(function* approveThenInspectWire() {
          const fiber = yield* (yield* EmailAgent).submit(input).pipe(Effect.forkScoped);
          const proposal = yield* Queue.take(proposals);
          assert.strictEqual(proposal.message.subject, input.subject);
          assert.strictEqual(yield* Queue.size(fixture.received), 0);
          yield* Deferred.succeed(release, true);
          const receipt = yield* Fiber.join(fiber);
          assert(EmailReceiptSchema.guards.Accepted(receipt));
          assert.strictEqual(String(receipt.messageId), "fictional-agent-ack");
          const request = yield* Queue.take(fixture.received);

          const wire = yield* Schema.decodeEffect(
            Schema.fromJsonString(
              Schema.Struct({
                From: Schema.String,
                Subject: Schema.String,
                TextBody: Schema.String,
                To: Schema.String,
              }),
            ),
          )(request.body);

          assert.strictEqual(wire.From, '"Host" <host@example.test>');
          assert.strictEqual(wire.Subject, input.subject);
          assert.strictEqual(wire.TextBody, input.body.text);
          assert.strictEqual(wire.To, input.to);
          assert.strictEqual(request.path, "/email");
        });

        yield* app.pipe(Effect.provide(agentLayer));
      }).pipe(Effect.scoped),
  );

  it.effect("preserves terminal suppression instead of inventing a sent result", () =>
    Effect.gen(function* verifyApprovedSuppression() {
      const fixture = yield* startEmailHttpFixture({
        body: JSON.stringify({
          warnings: [{ recipients: [{ email: input.to }], type: "ALL_SUPPRESSED" }],
        }),
        status: 202,
      });

      const provider = mailersendEmailLayer({ apiKey: Redacted.make("fictional-unused-key") }).pipe(
        Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.mailersend.com")),
      );

      const agentLayer = emailAgentLayer({ from }).pipe(
        Layer.provide(approvalLayer(() => Effect.succeed("Approved" as const))),
        Layer.provide(provider),
      );

      const receipt = yield* EmailAgent.pipe(
        Effect.flatMap((agent) => agent.submit(input)),
        Effect.provide(agentLayer),
      );

      assert(EmailReceiptSchema.guards.Suppressed(receipt));
      assert.deepStrictEqual(receipt.suppressed.map(String), [input.to]);
      assert(Object.isFrozen(receipt.suppressed));
      yield* Queue.take(fixture.received);
      assert.strictEqual(yield* Queue.size(fixture.received), 0);
    }).pipe(Effect.scoped),
  );

  it.effect("cancels an approved in-flight provider submission and closes its socket", () =>
    Effect.gen(function* verifyApprovedProviderCancellation() {
      const fixture = yield* startEmailHttpFixture({ body: "", hold: true, status: 200 });
      const reviews = yield* Ref.make(0);

      const provider = postmarkEmailLayer({
        serverToken: Redacted.make("fictional-unused-key"),
      }).pipe(Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.postmarkapp.com")));

      const agentLayer = emailAgentLayer({ from }).pipe(
        Layer.provide(
          approvalLayer(() =>
            Ref.update(reviews, (count) => count + 1).pipe(Effect.as("Approved" as const)),
          ),
        ),
        Layer.provide(provider),
      );

      const app = Effect.gen(function* interruptApprovedProviderRequest() {
        const fiber = yield* (yield* EmailAgent).submit(input).pipe(Effect.forkScoped);
        yield* Queue.take(fixture.received);
        yield* Fiber.interrupt(fiber);
        assert(Exit.hasInterrupts(yield* Fiber.await(fiber)));
        assert.strictEqual(yield* Queue.take(fixture.closed), true);
        assert.strictEqual(yield* Ref.get(reviews), 1);
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      });

      yield* app.pipe(Effect.provide(agentLayer));
    }).pipe(Effect.scoped),
  );

  it.effect.prop(
    "binds each generated reviewed body and recipient to its own submission",
    { suffix: Schema.String.check(Schema.isPattern(/^[a-z]{1,16}$/u)) },
    ({ suffix }) =>
      Effect.gen(function* verifyGeneratedAgentIntent() {
        const seen = yield* Queue.unbounded<EmailAgentProposal>();

        const app = Effect.gen(function* submitGeneratedApprovedMessage() {
          const generated = {
            body: { html: `<p>${suffix}</p>`, text: suffix },
            subject: suffix,
            to: `${suffix}@example.test`,
          };

          yield* (yield* EmailAgent).submit(generated);
          const proposal = yield* Queue.take(seen);
          const [sent] = yield* (yield* RecordedEmails).messages;
          assert.isDefined(sent);
          assert.deepStrictEqual(sent, proposal.message);
          assert.strictEqual(sent.body.html, `<p>${suffix}</p>`);
          assert.deepStrictEqual(sent.to.map(String), [generated.to]);
        });

        yield* app.pipe(
          Effect.provide(
            recordingAgentLayer((proposal) =>
              Queue.offer(seen, proposal).pipe(Effect.as("Approved" as const)),
            ),
          ),
        );
      }),
    { arbitrary: { runs: 12 } },
  );

  it.effect("approval unavailability preserves its original error and never submits", () =>
    Effect.gen(function* verifyUnavailableApproval() {
      const failure = new EmailAgentApprovalError({ reason: "unavailable" });

      const app = Effect.gen(function* failUnavailableApproval() {
        const result = yield* Effect.result((yield* EmailAgent).submit(input));
        assert(Result.isFailure(result));
        assert.strictEqual(result.failure, failure);
        assert.strictEqual((yield* (yield* RecordedEmails).messages).length, 0);
      });

      yield* app.pipe(Effect.provide(recordingAgentLayer(() => failure)));
    }),
  );

  it.effect.each(["Interrupt", "Defect"] as const)(
    "preserves approval %s without a submission",
    (mode) =>
      Effect.gen(function* verifyApprovalExit() {
        const entered = yield* Deferred.make<boolean>();
        const outcomes = { Defect: Effect.die("private-approval-defect"), Interrupt: Effect.never };
        const trace = yield* startEmailTraceFixture();

        const app = Effect.gen(function* interruptApprovalWait() {
          const fiber = yield* (yield* EmailAgent).submit(input).pipe(Effect.forkScoped);
          yield* Deferred.await(entered);

          if (mode === "Interrupt") {
            yield* Fiber.interrupt(fiber);
          }

          const exit = yield* Fiber.await(fiber);
          assert(Exit.isFailure(exit));
          assert.strictEqual(Exit.hasInterrupts(exit), mode === "Interrupt");
          assert.strictEqual(Exit.hasDies(exit), mode === "Defect");
          assert.strictEqual((yield* (yield* RecordedEmails).messages).length, 0);
        });

        yield* app.pipe(
          Effect.provide(
            recordingAgentLayer(() =>
              Deferred.succeed(entered, true).pipe(Effect.andThen(outcomes[mode])),
            ),
          ),
          Effect.withTracer(trace.tracer),
        );
        const diagnostics = yield* trace.diagnostics;
        assert.notInclude(diagnostics, "private-approval-defect");
        assert.notInclude(diagnostics, input.body.text);
      }).pipe(Effect.scoped),
  );

  it.effect("approval wait does not consume the underlying submission deadline", () =>
    Effect.gen(function* verifyApprovalAndSubmissionLifetimes() {
      const entered = yield* Deferred.make<boolean>();
      const release = yield* Deferred.make<boolean>();

      const app = Effect.gen(function* waitForHostThenSubmit() {
        const fiber = yield* (yield* EmailAgent)
          .submit(input, { policy: { ...policy, deadline: Duration.seconds(1) } })
          .pipe(Effect.forkScoped);

        yield* Deferred.await(entered);
        yield* TestClock.adjust("10 seconds");
        yield* Deferred.succeed(release, true);
        const receipt = yield* Fiber.join(fiber);
        assert.strictEqual(receipt._tag, "Recorded");
      });

      yield* app.pipe(
        Effect.provide(
          recordingAgentLayer(() =>
            Deferred.succeed(entered, true).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as("Approved" as const),
            ),
          ),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.effect(
    "does not turn authorized submission uncertainty into another attempt or new approval",
    () =>
      Effect.gen(function* verifyAgentUncertainty() {
        const requests = yield* Ref.make(0);
        const reviews = yield* Ref.make(0);
        const failure = new EmailDeliveryUnknown({ provider: "fixture", reason: "transport" });

        const sender = Layer.effect(
          EmailSender,
          Effect.gen(function* uncertainAgentFixtureSender() {
            const base = yield* EmailSender;

            return EmailSender.of({
              ...base,
              submit: () =>
                Ref.update(requests, (count) => count + 1).pipe(Effect.andThen(failure)),
            });
          }),
        ).pipe(Layer.provide(recordingSenderLayer));

        const agentLayer = emailAgentLayer({ from }).pipe(
          Layer.provide(
            approvalLayer(() =>
              Ref.update(reviews, (count) => count + 1).pipe(Effect.as("Approved" as const)),
            ),
          ),
          Layer.provide(emailLayer(policy).pipe(Layer.provide(sender))),
        );

        const result = yield* Effect.result(
          EmailAgent.pipe(
            Effect.flatMap((agent) => agent.submit(input)),
            Effect.provide(agentLayer),
          ),
        );

        assert(Result.isFailure(result));
        assert.strictEqual(result.failure, failure);
        assert.strictEqual(yield* Ref.get(requests), 1);
        assert.strictEqual(yield* Ref.get(reviews), 1);
      }),
  );

  it.effect("one approved logical operation retains its key across permitted rejection retry", () =>
    Effect.gen(function* verifyApprovedRejectionRetry() {
      const requests = yield* Queue.unbounded<string>();
      const attempts = yield* Ref.make(0);
      const reviews = yield* Ref.make(0);

      const sender = Layer.effect(
        EmailSender,
        Effect.gen(function* rejectingAgentFixtureSender() {
          const base = yield* EmailSender;

          return EmailSender.of({
            ...base,
            submit: Effect.fnUntraced(function* rejectFirstAgentAttempt(
              submission: EmailSubmission,
            ) {
              yield* Queue.offer(requests, submission.idempotencyKey ?? "unkeyed");
              const count = yield* Ref.updateAndGet(attempts, (value) => value + 1);

              return count === 1
                ? yield* new EmailRejected({
                    provider: "fixture",
                    reason: "temporarily-unavailable",
                  })
                : yield* base.submit(submission);
            }),
          });
        }),
      ).pipe(Layer.provide(recordingSenderLayer));

      const agentLayer = emailAgentLayer({ from }).pipe(
        Layer.provide(
          approvalLayer(() =>
            Ref.update(reviews, (count) => count + 1).pipe(Effect.as("Approved" as const)),
          ),
        ),
        Layer.provide(emailLayer(policy).pipe(Layer.provide(sender))),
      );

      const app = Effect.gen(function* retryApprovedAgentMessage() {
        const fiber = yield* (yield* EmailAgent)
          .submit(input, { idempotencyKey: "host-key" })
          .pipe(Effect.forkScoped);

        assert.strictEqual(yield* Queue.take(requests), "host-key");
        yield* TestClock.adjust("1 second");
        yield* Fiber.join(fiber);
        assert.strictEqual(yield* Queue.take(requests), "host-key");
        assert.strictEqual(yield* Ref.get(reviews), 1);
      });

      yield* app.pipe(Effect.provide(agentLayer));
    }).pipe(Effect.scoped),
  );

  it.effect("refuses invalid host configuration and keeps private content out of spans", () =>
    Effect.gen(function* verifyAgentConfigurationAndPrivacy() {
      const invalid = yield* Effect.result(
        EmailAgent.pipe(
          Effect.provide(
            emailAgentLayer({ from: "private-invalid-from" }).pipe(
              Layer.provide(approvalLayer(() => Effect.succeed("Declined" as const))),
              Layer.provide(recordingEmailLayer),
            ),
          ),
        ),
      );

      assert(Result.isFailure(invalid));
      assert(invalid.failure instanceof EmailConfigurationError);
      assert.notInclude(JSON.stringify(invalid.failure), "private-invalid-from");
      const trace = yield* startEmailTraceFixture();
      yield* EmailAgent.pipe(
        Effect.flatMap((agent) =>
          Effect.result(agent.submit(input, { idempotencyKey: "private-host-key" })),
        ),
        Effect.provide(recordingAgentLayer(() => Effect.succeed("Declined" as const))),
        Effect.withTracer(trace.tracer),
      );
      yield* EmailAgent.pipe(
        Effect.flatMap((agent) => agent.submit(input)),
        Effect.provide(recordingAgentLayer(() => Effect.succeed("Approved" as const))),
        Effect.withTracer(trace.tracer),
      );
      const diagnostics = yield* trace.diagnostics;

      for (const value of [
        input.subject,
        input.body.text,
        input.to,
        from.address,
        "private-host-key",
      ]) {
        assert.notInclude(diagnostics, value);
      }
    }),
  );
});
