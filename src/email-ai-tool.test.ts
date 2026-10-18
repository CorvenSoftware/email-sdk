import { assert, describe, it } from "@effect/vitest";
import { asSchema, generateText, stepCountIs } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Queue,
  Redacted,
  Ref,
  Schema,
  Scope,
} from "effect";
import { startEmailAiRunnerFixture } from "../test/email-ai-runner-fixture.js";
import { emailFixtureClientLayer, startEmailHttpFixture } from "../test/email-http-fixture.js";
import { postmarkEmailLayer } from "./postmark-email-sender.js";
import { mailersendEmailLayer } from "./mailersend-email-sender.js";
import { startEmailTraceFixture } from "../test/email-tracing-fixture.js";
import { EmailAgentApproval, EmailAgentApprovalError, emailAgentLayer } from "./email-agent.js";
import type { EmailAgentInput, EmailAgentProposal, IEmailAgentApproval } from "./email-agent.js";
import { EmailAiToolError, emailAiTool } from "./email-ai-tool.js";
import type { EmailAiTool } from "./email-ai-tool.js";
import { defaultedEmailLayer } from "./email-defaults.js";
import { EmailDeliveryUnknown } from "./email-delivery-unknown.js";
import { FailedEmailSubmissions, failingEmailLayer } from "./failing-email-sender.js";
import { formatEmailMailbox } from "./email-address.js";
import {
  RecordedEmails,
  recordingEmailLayer,
  recordingSenderLayer,
} from "./recording-email-sender.js";

const input = {
  body: { text: "Fictional private model body" },
  subject: "Fictional private model subject",
  to: "recipient@example.test",
};

const callOptions = {
  experimental_context: undefined,
  messages: [],
  toolCallId: "untrusted-call-id",
};

const agentLayer = (review: IEmailAgentApproval["review"]) =>
  emailAgentLayer({ from: "host@example.test" }).pipe(
    Layer.provide(Layer.succeed(EmailAgentApproval, EmailAgentApproval.of({ review }))),
    Layer.provideMerge(recordingEmailLayer),
  );

const execute = (tool: EmailAiTool, value: EmailAgentInput = input) =>
  Effect.promise(() => tool.execute(value, callOptions));

const toolError = (exit: Exit.Exit<unknown>) => {
  assert(Exit.isFailure(exit));
  const error = Cause.squash(exit.cause);
  assert(error instanceof EmailAiToolError);

  return error;
};

describe("AI SDK host-approved email tool", () => {
  it.effect(
    "runs actual AI SDK tool execution with effective host review and a private-data-free result",
    () =>
      Effect.gen(function* verifyAiSdkToolLoop() {
        const runner = yield* startEmailAiRunnerFixture();
        const proposals = yield* Queue.unbounded<EmailAgentProposal>();

        const base = defaultedEmailLayer(recordingEmailLayer, {
          headers: [{ name: "X-Host", value: "private-host-header" }],
        });

        const layers = emailAgentLayer({ from: "host@example.test" }).pipe(
          Layer.provide(
            Layer.succeed(
              EmailAgentApproval,
              EmailAgentApproval.of({
                review: (proposal) =>
                  Queue.offer(proposals, proposal).pipe(Effect.as("Approved" as const)),
              }),
            ),
          ),
          Layer.provideMerge(base),
          Layer.provideMerge(recordingSenderLayer),
        );

        yield* Effect.gen(function* executeRealToolLoop() {
          const sendEmail = yield* emailAiTool(runner.run);

          const model = new MockLanguageModelV4({
            doGenerate: {
              content: [
                {
                  input: JSON.stringify(input),
                  toolCallId: "call-1",
                  toolName: "sendEmail",
                  type: "tool-call",
                },
              ],
              finishReason: { raw: undefined, unified: "tool-calls" },
              usage: {
                inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
                outputTokens: { reasoning: 0, text: 1, total: 1 },
              },
              warnings: [],
            },
          });

          const result = yield* Effect.promise(
            (generateText<{ sendEmail: EmailAiTool }>).bind(undefined, {
              maxRetries: 0,
              model,
              prompt: "Fictional model fixture; no network or real approval UI.",
              stopWhen: stepCountIs(1),
              tools: { sendEmail },
            }),
          );

          assert.strictEqual(result.toolResults.length, 1);
          assert.deepStrictEqual(result.toolResults[0]?.output, { receiptKind: "Recorded" });
          const [recorded] = yield* (yield* RecordedEmails).messages;
          const proposal = yield* Queue.take(proposals);
          assert.deepStrictEqual(recorded, proposal.message);
          assert.strictEqual(recorded?.headers?.length, 1);
          assert.strictEqual(recorded?.body.text, input.body.text);
          assert.notInclude(JSON.stringify(result.toolResults[0]?.output), "private");
        }).pipe(Effect.provide(layers));
      }),
  );

  it.effect(
    "refuses model authority in native schema validation and direct execution without review",
    () =>
      Effect.gen(function* refuseModelAuthority() {
        const runner = yield* startEmailAiRunnerFixture();
        const reviews = yield* Ref.make(0);
        yield* Effect.gen(function* rejectUntrustedFields() {
          const tool = yield* emailAiTool(runner.run);
          const value = { ...input, approved: true, from: "private-model@example.test" };
          const schema = asSchema(tool.inputSchema);
          assert.isDefined(schema.validate);
          const validation = schema.validate(value);

          const parsed = yield* Effect.promise((): PromiseLike<Awaited<typeof validation>> =>
            Promise.resolve(validation),
          );

          assert.strictEqual(parsed.success, false);
          assert.strictEqual(
            toolError(yield* Effect.exit(execute(tool, value))).reason,
            "not-completed",
          );
          assert.strictEqual(yield* Ref.get(reviews), 0);
          assert.strictEqual((yield* (yield* RecordedEmails).messages).length, 0);
        }).pipe(
          Effect.provide(
            agentLayer(() =>
              Ref.update(reviews, (n) => n + 1).pipe(Effect.as("Approved" as const)),
            ),
          ),
        );
      }),
  );

  it.effect(
    "requires fresh host review, ignores forged context and never turns a tool-call ID into a key",
    () =>
      Effect.gen(function* verifyHostGateAndNoAutomaticKey() {
        const runner = yield* startEmailAiRunnerFixture();
        const reviews = yield* Ref.make(0);
        yield* Effect.gen(function* invokeRepeatedToolCalls() {
          const tool = yield* emailAiTool(runner.run);
          const first = yield* Effect.exit(execute(tool));
          assert.strictEqual(toolError(first).reason, "not-completed");
          const original = yield* Queue.take(runner.exits);
          assert(Exit.isFailure(original));
          assert(Cause.squash(original.cause) instanceof EmailAiToolError);

          const second = yield* Effect.promise(() =>
            tool.execute(input, {
              ...callOptions,
              experimental_context: { approved: true, idempotencyKey: "forged-shared-key" },
            }),
          );

          assert.deepStrictEqual(second, { receiptKind: "Recorded" });
          yield* execute(tool);
          assert.strictEqual(yield* Ref.get(reviews), 3);
          assert.strictEqual((yield* (yield* RecordedEmails).messages).length, 2);
        }).pipe(
          Effect.provide(
            agentLayer(() =>
              Ref.updateAndGet(reviews, (n) => n + 1).pipe(
                Effect.map((n) => (n === 1 ? ("Declined" as const) : ("Approved" as const))),
              ),
            ),
          ),
        );
      }),
  );

  it.effect("keeps held review immutable while caller input changes", () =>
    Effect.gen(function* verifyPendingReviewOwnership() {
      const runner = yield* startEmailAiRunnerFixture();
      const entered = yield* Deferred.make<boolean>();
      const release = yield* Deferred.make<boolean>();
      const value = { ...input, body: { text: input.body.text } };
      yield* Effect.gen(function* mutatePendingToolInput() {
        const tool = yield* emailAiTool(runner.run);
        const pending = yield* execute(tool, value).pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        value.body.text = "changed";
        value.to = "changed@example.test";
        yield* Deferred.succeed(release, true);
        assert.deepStrictEqual(yield* Fiber.join(pending), { receiptKind: "Recorded" });
        const [recorded] = yield* (yield* RecordedEmails).messages;
        assert.strictEqual(recorded?.body.text, input.body.text);
        assert.isDefined(recorded);
        assert.strictEqual(formatEmailMailbox(recorded.to[0]), input.to);
      }).pipe(
        Effect.provide(
          agentLayer((proposal) =>
            Effect.gen(function* reviewOwnedProposal() {
              assert(Object.isFrozen(proposal.message.body));
              yield* Deferred.succeed(entered, true);
              yield* Deferred.await(release);

              return "Approved" as const;
            }),
          ),
        ),
      );
    }),
  );

  it.effect("bridges AbortSignal during approval and does not submit", () =>
    Effect.gen(function* verifyFrameworkCancellation() {
      const runner = yield* startEmailAiRunnerFixture();
      const entered = yield* Deferred.make<boolean>();
      const released = yield* Deferred.make<boolean>();
      const abort = new AbortController();
      yield* Effect.gen(function* abortHeldToolReview() {
        const tool = yield* emailAiTool(runner.run);

        const pending = yield* Effect.promise(() =>
          tool.execute(input, { ...callOptions, abortSignal: abort.signal }),
        ).pipe(Effect.exit, Effect.forkScoped);

        yield* Deferred.await(entered);
        yield* Effect.sync(() => {
          abort.abort();
        });
        assert(Exit.isFailure(yield* Fiber.join(pending)));
        assert(Exit.hasInterrupts(yield* Queue.take(runner.exits)));
        yield* Deferred.await(released);
        assert.strictEqual((yield* (yield* RecordedEmails).messages).length, 0);
      }).pipe(
        Effect.provide(
          agentLayer(() =>
            Deferred.succeed(entered, true).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(released, true)),
            ),
          ),
        ),
      );
    }),
  );

  it.effect("closing the owner scope cancels an active tool and refuses later execution", () =>
    Effect.gen(function* verifyToolScopeLifetime() {
      const runner = yield* startEmailAiRunnerFixture();
      const entered = yield* Deferred.make<boolean>();
      const reviews = yield* Ref.make(0);
      const owner = yield* Scope.make();
      yield* Effect.gen(function* closeOwnerDuringApproval() {
        const tool = yield* emailAiTool(runner.run).pipe(Scope.provide(owner));
        const pending = yield* execute(tool).pipe(Effect.exit, Effect.forkScoped);
        yield* Deferred.await(entered);
        yield* Scope.close(owner, Exit.void);
        assert(Exit.isFailure(yield* Fiber.join(pending)));
        assert(Exit.hasInterrupts(yield* Queue.take(runner.exits)));
        assert(Exit.isFailure(yield* Effect.exit(execute(tool))));
        assert(Exit.hasInterrupts(yield* Queue.take(runner.exits)));
        assert.strictEqual(yield* Ref.get(reviews), 1);
        assert.strictEqual((yield* (yield* RecordedEmails).messages).length, 0);
      }).pipe(
        Effect.provide(
          agentLayer(() =>
            Ref.update(reviews, (n) => n + 1).pipe(
              Effect.andThen(Deferred.succeed(entered, true)),
              Effect.andThen(Effect.never),
            ),
          ),
        ),
      );
    }),
  );

  it.effect("does not replay uncertainty or expose private failures to the model", () =>
    Effect.gen(function* verifyUnknownToolSubmission() {
      const runner = yield* startEmailAiRunnerFixture();
      const failure = new EmailDeliveryUnknown({ provider: "failing", reason: "transport" });

      const layers = emailAgentLayer({ from: "host@example.test" }).pipe(
        Layer.provide(
          Layer.succeed(
            EmailAgentApproval,
            EmailAgentApproval.of({ review: () => Effect.succeed("Approved" as const) }),
          ),
        ),
        Layer.provideMerge(failingEmailLayer(failure)),
      );

      yield* Effect.gen(function* preserveUnknownHostOutcome() {
        const tool = yield* emailAiTool(runner.run);
        assert.strictEqual(toolError(yield* Effect.exit(execute(tool))).reason, "not-completed");
        const original = yield* Queue.take(runner.exits);
        assert(Exit.isFailure(original));
        assert(Cause.squash(original.cause) instanceof EmailAiToolError);
        assert.strictEqual((yield* (yield* FailedEmailSubmissions).attempts).length, 1);
      }).pipe(Effect.provide(layers));
    }),
  );

  it.effect(
    "preserves the defect channel with a safe boundary payload and status-only SDK spans",
    () =>
      Effect.gen(function* verifyPrivateDefectTranslation() {
        const trace = yield* startEmailTraceFixture();
        const defect = { private: "fictional-private-defect" };
        yield* Effect.gen(function* translateHostDefect() {
          const runner = yield* startEmailAiRunnerFixture();
          const tool = yield* emailAiTool(runner.run);
          const error = toolError(yield* Effect.exit(execute(tool)));
          assert.notInclude(JSON.stringify(error), defect.private);
          assert.notInclude(error.message, "not sent");
          const original = yield* Queue.take(runner.exits);
          assert(Exit.hasDies(original));
          assert(Exit.isFailure(original));
          assert(Cause.squash(original.cause) instanceof EmailAiToolError);
          assert.strictEqual(error.reason, "defect");
        }).pipe(
          Effect.provide(agentLayer(() => Effect.die(defect))),
          Effect.withTracer(trace.tracer),
        );
        const diagnostics = yield* trace.diagnostics;
        assert.include(diagnostics, "EmailAgent.submit");
        assert.notInclude(diagnostics, defect.private);
        assert.notInclude(diagnostics, input.subject);
        assert.notInclude(diagnostics, input.to);
      }),
  );

  it.effect(
    "retains compound failure, defect and interruption categories without private cause data",
    () =>
      Effect.gen(function* verifyCompoundToolFailure() {
        const runner = yield* startEmailAiRunnerFixture();
        const tool = yield* emailAiTool(runner.run);
        assert(Exit.isFailure(yield* Effect.exit(execute(tool))));
        const original = yield* Queue.take(runner.exits);
        assert(Exit.hasDies(original));
        assert(Exit.hasInterrupts(original));
        assert(Exit.isFailure(original));
        assert(Cause.hasFails(original.cause));
        assert.notInclude(JSON.stringify(original.cause), "fictional-private-combined-defect");
      }).pipe(
        Effect.provide(
          agentLayer(() =>
            Effect.failCause(
              Cause.combine(
                Cause.fail(new EmailAgentApprovalError({ reason: "unavailable" })),
                Cause.combine(
                  Cause.die({ private: "fictional-private-combined-defect" }),
                  Cause.interrupt(),
                ),
              ),
            ),
          ),
        ),
      ),
  );

  it.effect("honors a pre-aborted framework signal before host review", () =>
    Effect.gen(function* verifyPreAbortedToolCall() {
      const runner = yield* startEmailAiRunnerFixture();
      const abort = new AbortController();
      abort.abort();
      const tool = yield* emailAiTool(runner.run);

      const exit = yield* Effect.promise(() =>
        tool.execute(input, { ...callOptions, abortSignal: abort.signal }),
      ).pipe(Effect.exit);

      assert(Exit.isFailure(exit));
      assert(Exit.hasInterrupts(yield* Queue.take(runner.exits)));
      assert.strictEqual((yield* (yield* RecordedEmails).messages).length, 0);
    }).pipe(Effect.provide(agentLayer(() => Effect.die("pre-aborted review must not run")))),
  );

  it.effect(
    "projects actual provider acceptance without exposing its private acknowledgement ID",
    () =>
      Effect.gen(function* verifyAcceptedToolProjection() {
        const runner = yield* startEmailAiRunnerFixture();

        const fixture = yield* startEmailHttpFixture({
          body: '{"ErrorCode":0,"MessageID":"private-acknowledgement"}',
          status: 200,
        });

        const provider = postmarkEmailLayer({
          serverToken: Redacted.make("fictional-unused-key"),
        }).pipe(Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.postmarkapp.com")));

        const layers = emailAgentLayer({ from: "host@example.test" }).pipe(
          Layer.provide(
            Layer.succeed(
              EmailAgentApproval,
              EmailAgentApproval.of({ review: () => Effect.succeed("Approved" as const) }),
            ),
          ),
          Layer.provide(provider),
        );

        yield* Effect.gen(function* inspectAcceptedToolResult() {
          const tool = yield* emailAiTool(runner.run);
          const result = yield* execute(tool);
          assert.deepStrictEqual(result, { receiptKind: "Accepted" });
          assert(Object.isFrozen(result));
          assert.notInclude(JSON.stringify(result), "private-acknowledgement");
          const request = yield* Queue.take(fixture.received);
          assert.strictEqual(request.path, "/email");
          assert.include(request.body, input.body.text);
        }).pipe(Effect.provide(layers));
      }),
  );

  it.effect("reports actual terminal suppression instead of claiming email was sent", () =>
    Effect.gen(function* verifySuppressedToolResult() {
      const runner = yield* startEmailAiRunnerFixture();

      const fixture = yield* startEmailHttpFixture({
        body: JSON.stringify({
          warnings: [{ recipients: [{ email: input.to }], type: "ALL_SUPPRESSED" }],
        }),
        status: 202,
      });

      const provider = mailersendEmailLayer({ apiKey: Redacted.make("fictional-unused-key") }).pipe(
        Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.mailersend.com")),
      );

      const layers = emailAgentLayer({ from: "host@example.test" }).pipe(
        Layer.provide(
          Layer.succeed(
            EmailAgentApproval,
            EmailAgentApproval.of({ review: () => Effect.succeed("Approved" as const) }),
          ),
        ),
        Layer.provide(provider),
      );

      yield* Effect.gen(function* inspectSuppressedToolResult() {
        const tool = yield* emailAiTool(runner.run);
        assert.deepStrictEqual(yield* execute(tool), { receiptKind: "Suppressed" });
        yield* Queue.take(fixture.received);
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }).pipe(Effect.provide(layers));
    }),
  );

  it.effect("aborting approved provider work closes the held socket without another request", () =>
    Effect.gen(function* verifyApprovedToolTransportCancellation() {
      const runner = yield* startEmailAiRunnerFixture();
      const fixture = yield* startEmailHttpFixture({ body: "", hold: true, status: 200 });
      const abort = new AbortController();

      const provider = postmarkEmailLayer({
        serverToken: Redacted.make("fictional-unused-key"),
      }).pipe(Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.postmarkapp.com")));

      const layers = emailAgentLayer({ from: "host@example.test" }).pipe(
        Layer.provide(
          Layer.succeed(
            EmailAgentApproval,
            EmailAgentApproval.of({ review: () => Effect.succeed("Approved" as const) }),
          ),
        ),
        Layer.provide(provider),
      );

      yield* Effect.gen(function* abortApprovedHttpToolCall() {
        const tool = yield* emailAiTool(runner.run);

        const pending = yield* Effect.promise(() =>
          tool.execute(input, { ...callOptions, abortSignal: abort.signal }),
        ).pipe(Effect.exit, Effect.forkScoped);

        yield* Queue.take(fixture.received);
        yield* Effect.sync(() => {
          abort.abort();
        });
        assert(Exit.isFailure(yield* Fiber.join(pending)));
        assert(Exit.hasInterrupts(yield* Queue.take(runner.exits)));
        assert.strictEqual(yield* Queue.take(fixture.closed), true);
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }).pipe(Effect.provide(layers));
    }),
  );

  it.effect("cancels one parallel review without cancelling or merging its peer", () =>
    Effect.gen(function* verifyIndependentParallelToolCalls() {
      const runner = yield* startEmailAiRunnerFixture();
      const entered = yield* Deferred.make<boolean>();
      const abort = new AbortController();
      yield* Effect.gen(function* runParallelToolCalls() {
        const tool = yield* emailAiTool(runner.run);

        const pending = yield* Effect.promise(() =>
          tool.execute(
            { ...input, subject: "held" },
            { ...callOptions, abortSignal: abort.signal },
          ),
        ).pipe(Effect.exit, Effect.forkScoped);

        yield* Deferred.await(entered);
        assert.deepStrictEqual(yield* execute(tool), { receiptKind: "Recorded" });
        yield* Effect.sync(() => {
          abort.abort();
        });
        assert(Exit.isFailure(yield* Fiber.join(pending)));
        const recorded = yield* (yield* RecordedEmails).messages;
        assert.strictEqual(recorded.length, 1);
        assert.strictEqual(recorded[0]?.subject, input.subject);
      }).pipe(
        Effect.provide(
          agentLayer((proposal) =>
            proposal.message.subject === "held"
              ? Deferred.succeed(entered, true).pipe(Effect.andThen(Effect.never))
              : Effect.succeed("Approved" as const),
          ),
        ),
      );
    }),
  );

  it.effect.prop(
    "carries generated model bodies through actual schema validation, review and recording",
    {
      body: Schema.NonEmptyString.check(Schema.isMaxLength(150)),
    },
    ({ body }) =>
      Effect.gen(function* verifyGeneratedToolBody() {
        const runner = yield* startEmailAiRunnerFixture();
        yield* Effect.gen(function* executeGeneratedInput() {
          const tool = yield* emailAiTool(runner.run);
          const value = { ...input, body: { text: body } };

          const schema = asSchema(tool.inputSchema);
          assert.isDefined(schema.validate);
          const validation = schema.validate(value);

          const parsed = yield* Effect.promise((): PromiseLike<Awaited<typeof validation>> =>
            Promise.resolve(validation),
          );

          assert.strictEqual(parsed.success, true);
          assert.deepStrictEqual(yield* execute(tool, value), { receiptKind: "Recorded" });
          const [recorded] = yield* (yield* RecordedEmails).messages;
          assert.strictEqual(recorded?.body.text, body);
        }).pipe(Effect.provide(agentLayer(() => Effect.succeed("Approved" as const))));
      }),
    { arbitrary: { runs: 12 } },
  );
});
