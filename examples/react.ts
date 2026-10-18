import { Effect } from "effect";
import { createElement } from "react";
import { Email } from "../src/index.js";
import {
  reactEmailTheme,
  renderReactEmail,
  themedReactEmailComponents,
} from "../src/email-react.js";

const { EmailAction, EmailCard, EmailDivider, EmailDocument, EmailHeading, EmailParagraph } =
  themedReactEmailComponents(
    reactEmailTheme("light", { accent: "#234c39", fontFamily: "Georgia, serif" }),
  );

export const submitRenderedReactExample = Effect.gen(function* submitRenderedReactExample() {
  const body = yield* renderReactEmail(
    createElement(
      EmailDocument,
      { lang: "en", preview: "A synthetic component-catalog example." },
      createElement(
        EmailCard,
        null,
        createElement(EmailHeading, null, "Fictional notification"),
        createElement(EmailParagraph, null, "Fictional content rendered before submission."),
        createElement(EmailAction, { href: "https://example.invalid/review" }, "Review example"),
        createElement(EmailDivider),
        createElement(
          EmailParagraph,
          { tone: "muted" },
          "Synthetic content, not a customer message.",
        ),
      ),
    ),
  );

  const email = yield* Email;

  return yield* email.send({
    body,
    from: "sender@example.invalid",
    subject: "Synthetic React email example",
    to: "recipient@example.invalid",
  });
});
