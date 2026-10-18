import { assert, describe, it } from "@effect/vitest";
import { Button, Html, Text } from "react-email";
import { Effect, Exit, Fiber, Queue, Schema } from "effect";
import { createElement, Suspense, use } from "react";
import { startEmailTraceFixture } from "../test/email-tracing-fixture.js";
import { Email } from "./index.js";
import { maxEmailBodyCharacters } from "./email-message.js";
import { EmailRenderError, renderReactEmail } from "./email-react.js";
import { RecordedEmails, recordingEmailLayer } from "./recording-email-sender.js";

const renderedCharacters = Schema.NonEmptyArray(
  Schema.Literals(["a", "Z", "0", "&", "<", ">", "'", '"', "é", "😀"]),
).check(Schema.isMaxLength(60));

const fictionalMessage = {
  from: "sender@example.invalid",
  subject: "Synthetic React rendering",
  to: "recipient@example.invalid",
};

const FailingEmailTemplate = ({ message }: { readonly message: string }): never => {
  throw new Error(message);
};

describe("React email rendering", () => {
  it.effect(
    "renders actual React Email components into frozen HTML and text and records both",
    () =>
      Effect.gen(function* renderNativeReactEmailComponents() {
        const template = createElement(
          Html,
          { lang: "en" },
          createElement(
            "body",
            null,
            createElement(Text, null, "Fictional private component content"),
            createElement(Button, { href: "https://example.invalid/fictional" }, "Review example"),
            createElement("img", { alt: "Fictional mark", src: "cid:fictional-mark" }),
          ),
        );

        const body = yield* renderReactEmail(template);
        assert.include(body.html, "Fictional private component content");
        assert.include(body.html, 'href="https://example.invalid/fictional"');
        assert.include(body.html, 'src="cid:fictional-mark"');
        assert.include(body.text, "Fictional private component content");
        assert.include(body.text, "Review example");
        assert.include(body.text, "https://example.invalid/fictional");
        assert.isFrozen(body);
        assert.isFalse(Reflect.set(body, "html", "changed"));
        const email = yield* Email;
        yield* email.send({ ...fictionalMessage, body }, { idempotencyKey: "rendered-once" });
        yield* email.send({ ...fictionalMessage, body }, { idempotencyKey: "rendered-once" });
        const records = yield* (yield* RecordedEmails).messages;
        assert.strictEqual(records.length, 1);
        assert.deepStrictEqual(records[0]?.body, body);
      }).pipe(Effect.provide(recordingEmailLayer)),
  );

  it.effect.prop(
    "escapes generated text in HTML while preserving its literal plain-text meaning",
    [renderedCharacters],
    ([characters]) =>
      Effect.gen(function* renderGeneratedReactContent() {
        const content = characters.join("");
        const body = yield* renderReactEmail(createElement("p", null, content));
        assert.strictEqual(body.text, content);
        const email = yield* Email;
        const prepared = yield* email.validate({ ...fictionalMessage, body });
        assert.deepStrictEqual(prepared.body, body);
      }).pipe(Effect.provide(recordingEmailLayer)),
    { arbitrary: { runs: 12 } },
  );

  it.effect("does not invoke host components until the rendering Effect executes", () =>
    Effect.gen(function* verifyLazyReactRendering() {
      let executions = 0;

      const Template = () => {
        executions += 1;

        return createElement("p", null, "Fictional lazy content");
      };

      const operation = renderReactEmail(createElement(Template));
      assert.strictEqual(executions, 0);
      assert.strictEqual((yield* operation).text, "Fictional lazy content");
      assert.isAbove(executions, 0);
    }),
  );

  it.effect("rejects a serialized element-shaped object instead of treating it as a template", () =>
    Effect.gen(function* refuseSerializedReactElement() {
      const error = yield* Effect.flip(
        renderReactEmail({ key: null, props: { children: "private-object-content" }, type: "p" }),
      );

      assert.instanceOf(error, EmailRenderError);
      assert.strictEqual(error.reason, "invalid-template");
      assert.notInclude(JSON.stringify(error), "private-object-content");
    }),
  );

  it.effect("waits for suspended host content without publishing the fallback", () =>
    Effect.gen(function* awaitCompleteReactContent() {
      const entered = yield* Queue.unbounded<boolean>();
      const pending = Promise.withResolvers<string>();

      const Template = () => {
        Queue.offerUnsafe(entered, true);

        return createElement("p", null, use(pending.promise));
      };

      const template = createElement(
        Suspense,
        { fallback: createElement("p", null, "Fictional pending fallback") },
        createElement(Template),
      );

      const fiber = yield* renderReactEmail(template).pipe(Effect.forkScoped);
      yield* Queue.take(entered);
      pending.resolve("Fictional completed content");
      const body = yield* Fiber.join(fiber);
      assert.strictEqual(body.text, "Fictional completed content");
      assert.notInclude(body.html, "Fictional pending fallback");
    }),
  );

  it.effect("a late suspended rejection cannot publish its fallback or reach submission", () =>
    Effect.gen(function* refuseSuspendedReactFailure() {
      const entered = yield* Queue.unbounded<boolean>();
      const pending = Promise.withResolvers<string>();

      const Template = () => {
        Queue.offerUnsafe(entered, true);

        return createElement("p", null, use(pending.promise));
      };

      const email = yield* Email;

      const fiber = yield* renderReactEmail(
        createElement(
          Suspense,
          {
            fallback: createElement("p", null, "Private incomplete fallback"),
          },
          createElement(Template),
        ),
      ).pipe(
        Effect.flatMap((body) => email.send({ ...fictionalMessage, body })),
        Effect.forkScoped,
      );

      yield* Queue.take(entered);
      pending.reject(new Error("private-suspended-rendering-error"));
      const error = yield* Effect.flip(Fiber.join(fiber));
      assert.instanceOf(error, EmailRenderError);
      assert.notInclude(JSON.stringify(error), "private-suspended-rendering-error");
      assert.deepStrictEqual(yield* (yield* RecordedEmails).messages, []);
    }).pipe(Effect.provide(recordingEmailLayer)),
  );

  it.effect(
    "concurrent suspended renders retain their own content in reverse completion order",
    () =>
      Effect.gen(function* isolateConcurrentReactRendering() {
        const entered = yield* Queue.unbounded<boolean>();
        const first = Promise.withResolvers<string>();
        const second = Promise.withResolvers<string>();

        const Template = ({ pending }: { readonly pending: Promise<string> }) => {
          Queue.offerUnsafe(entered, true);

          return createElement("p", null, use(pending));
        };

        const firstFiber = yield* renderReactEmail(
          createElement(Template, {
            pending: first.promise,
          }),
        ).pipe(Effect.forkScoped);

        yield* Queue.take(entered);

        const secondFiber = yield* renderReactEmail(
          createElement(Template, {
            pending: second.promise,
          }),
        ).pipe(Effect.forkScoped);

        yield* Queue.take(entered);
        second.resolve("Fictional private second content");
        const secondBody = yield* Fiber.join(secondFiber);
        assert.strictEqual(secondBody.text, "Fictional private second content");
        assert.notInclude(secondBody.html, "Fictional private first content");
        first.resolve("Fictional private first content");
        const firstBody = yield* Fiber.join(firstFiber);
        assert.strictEqual(firstBody.text, "Fictional private first content");
        assert.notInclude(firstBody.html, "Fictional private second content");
      }),
  );

  for (const wrapped of [false, true]) {
    it.effect(
      `refuses host component failure without publishing ${wrapped ? "Suspense fallback" : "partial content"}`,
      () =>
        Effect.gen(function* refuseFailedReactContent() {
          const element = createElement(FailingEmailTemplate, {
            message: "private-template-error-and-properties",
          });

          const template = wrapped
            ? createElement(
                Suspense,
                { fallback: createElement("p", null, "Private fallback") },
                element,
              )
            : element;

          const error = yield* Effect.flip(renderReactEmail(template));
          assert.instanceOf(error, EmailRenderError);
          assert.strictEqual(error.reason, "render-failed");
          assert.notInclude(error.message, "private-template");
          assert.notInclude(JSON.stringify(error), "private-template");
        }),
    );
  }

  it.effect("retains React Email's explicit plain-text exclusion without deleting HTML", () =>
    Effect.gen(function* preserveReactTextProjectionRules() {
      const body = yield* renderReactEmail(
        createElement(
          "div",
          null,
          createElement("p", null, "Fictional visible content"),
          createElement("p", { "data-skip-in-text": "true" }, "Fictional HTML-only content"),
        ),
      );

      assert.include(body.html, "Fictional HTML-only content");
      assert.strictEqual(body.text, "Fictional visible content");
    }),
  );

  it.effect("refuses an empty generated text alternative rather than silently omitting it", () =>
    Effect.gen(function* refuseEmptyGeneratedText() {
      const error = yield* Effect.flip(
        renderReactEmail(
          createElement("img", {
            alt: "Private image-only template",
            src: "https://example.invalid/fictional.png",
          }),
        ),
      );

      assert.strictEqual(error.reason, "invalid-output");
      assert.notInclude(error.message, "Private image");
    }),
  );

  it.effect("accepts the exact generated HTML boundary and refuses one extra character", () =>
    Effect.gen(function* boundReactOutput() {
      const baseline = yield* renderReactEmail(createElement("p", null, "x"));
      const size = maxEmailBodyCharacters - baseline.html.length + 1;
      const content = "x".repeat(size);
      const body = yield* renderReactEmail(createElement("p", null, content));
      assert.strictEqual(body.html.length, maxEmailBodyCharacters);
      assert.strictEqual(body.text, content);

      const error = yield* Effect.flip(
        renderReactEmail(createElement("p", null, "x".repeat(size + 1))),
      );

      assert.strictEqual(error.reason, "invalid-output");
    }),
  );

  it.effect(
    "interruption prevents subsequent sending even when native host work completes later",
    () =>
      Effect.gen(function* interruptReactRendering() {
        const entered = yield* Queue.unbounded<boolean>();
        const completed = yield* Queue.unbounded<boolean>();
        const pending = Promise.withResolvers<string>();

        const Template = () => {
          Queue.offerUnsafe(entered, true);
          const text = use(pending.promise);
          Queue.offerUnsafe(completed, true);

          return createElement("p", null, text);
        };

        const email = yield* Email;

        const fiber = yield* renderReactEmail(createElement(Template)).pipe(
          Effect.flatMap((body) => email.send({ ...fictionalMessage, body })),
          Effect.forkScoped,
        );

        yield* Queue.take(entered);
        yield* Fiber.interrupt(fiber);
        const exit = yield* Fiber.await(fiber);
        assert.isTrue(Exit.hasInterrupts(exit));
        pending.resolve("Fictional content completed after cancellation");
        yield* Queue.take(completed);
        assert.deepStrictEqual(yield* (yield* RecordedEmails).messages, []);
      }).pipe(Effect.provide(recordingEmailLayer)),
  );

  it.effect("SDK span exits retain neither rendered bodies nor rejected component errors", () =>
    Effect.gen(function* inspectReactRenderingDiagnostics() {
      const fixture = yield* startEmailTraceFixture();

      yield* Effect.gen(function* traceRealReactRendering() {
        yield* renderReactEmail(createElement("p", null, "private-react-body-token"));
        yield* renderReactEmail(
          createElement(FailingEmailTemplate, {
            message: "private-react-error-token",
          }),
        ).pipe(Effect.result);
      }).pipe(Effect.withTracer(fixture.tracer));
      const diagnostics = yield* fixture.diagnostics;
      assert.include(diagnostics, "ReactEmail.render");
      assert.notInclude(diagnostics, "private-react-body-token");
      assert.notInclude(diagnostics, "private-react-error-token");
    }),
  );
});
