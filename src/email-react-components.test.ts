import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { createElement } from "react";
import { Email } from "./index.js";
import { maxEmailBodyCharacters } from "./email-message.js";
import { reactEmailTheme, renderReactEmail, themedReactEmailComponents } from "./email-react.js";
import type { ReactEmailTheme } from "./email-react.js";
import { RecordedEmails, recordingEmailLayer } from "./recording-email-sender.js";

const fictionalTheme: ReactEmailTheme = {
  accent: "#234c39",
  accentForeground: "#ffffff",
  background: "#f5f2e9",
  border: "#a6aa9d",
  fontFamily: "Georgia, serif",
  foreground: "#20291e",
  mutedForeground: "#4b5547",
  radius: 12,
  surface: "#ffffff",
  surfaceForeground: "#20291e",
};

const generatedContent = Schema.NonEmptyArray(
  Schema.Literals(["A", "0", "&", "<script>", "<", ">", "'", '"', "é", "😀"]),
).check(Schema.isMaxLength(40));

describe("themed React email components", () => {
  it.effect.each(["light", "dark"] as const)(
    "renders the %s preset with readable content, preserved links and no preview in text",
    (preset) =>
      Effect.gen(function* renderPresetReactEmail() {
        const theme = reactEmailTheme(preset);

        const { EmailAction, EmailCard, EmailDocument, EmailHeading, EmailParagraph } =
          themedReactEmailComponents(preset);

        const body = yield* renderReactEmail(
          createElement(
            EmailDocument,
            { preview: "Synthetic preview" },
            createElement(
              EmailCard,
              null,
              createElement(EmailHeading, null, "Account notification"),
              createElement(EmailParagraph, { tone: "muted" }, "Fictional account content."),
              createElement(
                EmailAction,
                { href: "https://example.invalid/review" },
                "Review account",
              ),
            ),
          ),
        );

        assert.include(body.html, `background-color:${theme.background}`);
        assert.include(body.html, `background-color:${theme.surface}`);
        assert.include(body.html, `background-color:${theme.accent}`);
        assert.include(body.html, `color:${theme.accentForeground}`);
        assert.include(body.html, `color:${theme.mutedForeground}`);
        assert.include(body.text, "ACCOUNT NOTIFICATION");
        assert.include(body.text, "Fictional account content.");
        assert.include(body.text, "https://example.invalid/review");
        assert.notInclude(body.text, "Synthetic preview");
      }),
  );

  it.effect(
    "defaults to a light family and detaches partial dark overrides without changing other families",
    () =>
      Effect.gen(function* customizePresetReactEmail() {
        const overrides = { accent: "#234c39", accentForeground: "#ffffff", radius: 0 };
        const custom = reactEmailTheme("dark", overrides);
        const family = themedReactEmailComponents(custom);
        overrides.accent = "#ff0000";
        const defaults = themedReactEmailComponents();
        const dark = themedReactEmailComponents("dark");

        const body = yield* renderReactEmail(
          createElement(
            defaults.EmailDocument,
            null,
            createElement(
              family.EmailCard,
              null,
              createElement(
                family.EmailAction,
                { href: "https://example.invalid" },
                "Custom action",
              ),
              createElement(dark.EmailParagraph, null, "Dark content"),
            ),
          ),
        );

        assert.isFrozen(custom);
        assert.isFalse(Reflect.set(custom, "accent", "#ff0000"));
        assert.include(body.html, `background-color:${reactEmailTheme().background}`);
        assert.include(body.html, `background-color:${reactEmailTheme("dark").surface}`);
        assert.include(body.html, "background-color:#234c39");
        assert.include(body.html, "border-radius:0");
        assert.notInclude(body.html, "#ff0000");
        assert.include(body.text, "Custom action");
        assert.include(body.text, "Dark content");
      }),
  );
  it.effect("renders a complete semantic document and records its generated body", () =>
    Effect.gen(function* renderThemedEmailDocument() {
      const { EmailAction, EmailCard, EmailDivider, EmailDocument, EmailHeading, EmailParagraph } =
        themedReactEmailComponents(fictionalTheme);

      const body = yield* renderReactEmail(
        createElement(
          EmailDocument,
          { lang: "fr", preview: "Private inbox preview" },
          createElement(
            EmailCard,
            null,
            createElement(EmailHeading, null, "Fictional notification"),
            createElement(EmailParagraph, null, "Synthetic content, not a customer message."),
            createElement(
              EmailAction,
              { href: "https://example.invalid/review" },
              "Review example",
            ),
            createElement(EmailDivider),
            createElement(EmailParagraph, { tone: "muted" }, "Fictional footer"),
          ),
        ),
      );

      assert.include(body.html, 'lang="fr"');
      assert.include(body.html, 'role="presentation"');
      assert.include(body.html, "<h1");
      assert.include(body.html, "<hr");
      assert.include(body.html, "Private inbox preview");
      assert.notInclude(body.text, "Private inbox preview");
      assert.include(body.text, "FICTIONAL NOTIFICATION");
      assert.include(body.text, "Synthetic content, not a customer message.");
      assert.include(body.text, "Review example");
      assert.include(body.text, "https://example.invalid/review");
      assert.include(body.text, "Fictional footer");
      const email = yield* Email;
      yield* email.send({
        body,
        from: "sender@example.invalid",
        subject: "Synthetic",
        to: "recipient@example.invalid",
      });
      assert.deepStrictEqual((yield* (yield* RecordedEmails).messages)[0]?.body, body);
    }).pipe(Effect.provide(recordingEmailLayer)),
  );

  it.effect("owns the supplied theme before caller mutation and later rendering", () =>
    Effect.gen(function* ownReactEmailTheme() {
      const input = { ...fictionalTheme };
      const components = themedReactEmailComponents(input);
      input.background = "#000000";
      input.accent = "#ff0000";
      input.fontFamily = "monospace";
      input.radius = 99;
      assert.isFrozen(components);
      assert.isFalse(
        Reflect.set(components, "EmailDocument", () => createElement("p", null, "changed")),
      );

      const body = yield* renderReactEmail(
        createElement(
          components.EmailDocument,
          null,
          createElement(
            components.EmailAction,
            { href: "https://example.invalid" },
            "Fictional action",
          ),
        ),
      );

      assert.include(body.html, "background-color:#f5f2e9");
      assert.include(body.html, "background-color:#234c39");
      assert.include(body.html, "font-family:Georgia, serif");
      assert.include(body.html, "border-radius:12px");
      assert.notInclude(body.html, "#ff0000");
      assert.notInclude(body.html, "monospace");
      assert.notInclude(body.html, "99px");
    }),
  );

  it.effect("nested independent catalogs do not inherit or overwrite one another's theme", () =>
    Effect.gen(function* isolateReactEmailComponentThemes() {
      const outer = themedReactEmailComponents(fictionalTheme);
      const inner = themedReactEmailComponents({ ...fictionalTheme, surfaceForeground: "#341345" });

      const body = yield* renderReactEmail(
        createElement(
          outer.EmailDocument,
          null,
          createElement(
            inner.EmailCard,
            null,
            createElement(outer.EmailParagraph, null, "Outer content"),
            createElement(inner.EmailParagraph, null, "Inner content"),
            createElement(outer.EmailParagraph, null, "Outer again"),
          ),
        ),
      );

      assert.match(body.html, /color:#20291e[^>]*>Outer content<\/p>/u);
      assert.match(body.html, /color:#341345[^>]*>Inner content<\/p>/u);
      assert.match(body.html, /color:#20291e[^>]*>Outer again<\/p>/u);
    }),
  );

  it.effect("preserves native attributes and explicit host style overrides", () =>
    Effect.gen(function* preserveReactEmailComponentIntent() {
      const { EmailAction, EmailCard, EmailDocument, EmailHeading, EmailParagraph } =
        themedReactEmailComponents(fictionalTheme);

      const body = yield* renderReactEmail(
        createElement(
          EmailDocument,
          { bodyStyle: { padding: 0 }, dir: "rtl" },
          createElement(
            EmailCard,
            { style: { maxWidth: "480px" }, title: "Fictional card" },
            createElement(
              EmailHeading,
              { level: 2, style: { color: "#112233" } },
              "Section heading",
            ),
            createElement(EmailParagraph, { style: { margin: 0 }, tone: "muted" }, "Muted content"),
            createElement(
              EmailAction,
              {
                "aria-label": "Review fictional content",
                href: "https://example.invalid",
                variant: "outline",
              },
              "Review",
            ),
          ),
        ),
      );

      assert.include(body.html, 'dir="rtl"');
      assert.include(body.html, "padding:0");
      assert.include(body.html, "max-width:480px");
      assert.include(body.html, 'title="Fictional card"');
      assert.match(body.html, /<h2[^>]*color:#112233/u);
      assert.include(body.html, "color:#4b5547");
      assert.include(body.html, "background-color:transparent");
      assert.include(body.html, 'aria-label="Review fictional content"');
    }),
  );

  it.effect.prop(
    "escapes catalog content and preview while excluding preview from generated text",
    [generatedContent],
    ([characters]) =>
      Effect.gen(function* preserveGeneratedCatalogContent() {
        const content = characters.join("");
        const { EmailDocument, EmailParagraph } = themedReactEmailComponents(fictionalTheme);

        const body = yield* renderReactEmail(
          createElement(
            EmailDocument,
            { preview: `Preview ${content}` },
            createElement(EmailParagraph, null, content),
          ),
        );

        assert.strictEqual(body.text, content);
        assert.notInclude(body.html, "<script>");
      }),
    { arbitrary: { runs: 12 } },
  );

  it.effect("hidden preview still consumes the common HTML output budget", () =>
    Effect.gen(function* boundHiddenReactEmailPreview() {
      const { EmailDocument, EmailParagraph } = themedReactEmailComponents(fictionalTheme);

      const failure = yield* Effect.flip(
        renderReactEmail(
          createElement(
            EmailDocument,
            { preview: "x".repeat(maxEmailBodyCharacters) },
            createElement(EmailParagraph, null, "Fictional body"),
          ),
        ),
      );

      assert.strictEqual(failure.reason, "invalid-output");
    }),
  );

  it.effect("does not create nonempty message text from a preview-only document", () =>
    Effect.gen(function* refusePreviewOnlyReactEmail() {
      const { EmailDocument } = themedReactEmailComponents(fictionalTheme);

      const failure = yield* Effect.flip(
        renderReactEmail(createElement(EmailDocument, { preview: "Private preview only" })),
      );

      assert.strictEqual(failure.reason, "invalid-output");
      assert.notInclude(JSON.stringify(failure), "Private preview only");
    }),
  );
});
