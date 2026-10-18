import { render, toPlainText } from "@react-email/render";
import { Effect, Schema } from "effect";
import { isValidElement } from "react";
import type { ReactElement } from "react";
import { EmailBodySchema } from "./email-message.js";
import { emailOperationSpan } from "./email-tracing.js";

export { themedReactEmailComponents } from "./email-react-components.js";

export { reactEmailTheme } from "./email-react-theme.js";

export type { ReactEmailTheme, ReactEmailThemePreset } from "./email-react-theme.js";

export type {
  ReactEmailActionProps,
  ReactEmailCardProps,
  ReactEmailComponents,
  ReactEmailDividerProps,
  ReactEmailDocumentProps,
  ReactEmailHeadingProps,
  ReactEmailParagraphProps,
} from "./email-react-components.js";

export class EmailRenderError extends Schema.TaggedError<EmailRenderError>()("EmailRenderError", {
  reason: Schema.Literals(["invalid-template", "render-failed", "invalid-output"]),
}) {
  override get message(): string {
    return `Email React rendering failed (${this.reason}); no rendered body was returned.`;
  }
}

export const RenderedReactEmailSchema = Schema.Struct({
  html: Schema.String,
  text: Schema.String,
}).check(Schema.makeFilter(Schema.is(EmailBodySchema), { expected: "a valid common email body" }));

export type RenderedReactEmail = typeof RenderedReactEmailSchema.Type;

const ReactEmailElement = Schema.declare<ReactElement>(isValidElement);

export const renderReactEmail: (
  template: ReactElement,
) => Effect.Effect<RenderedReactEmail, EmailRenderError> = Effect.fnUntraced(
  function* renderReactEmail(
    template: ReactElement,
  ): Effect.fn.Return<RenderedReactEmail, EmailRenderError> {
    const element = yield* ReactEmailElement.makeEffect(template).pipe(
      Effect.mapError(() => new EmailRenderError({ reason: "invalid-template" })),
    );

    const html = yield* Effect.tryPromise({
      catch: () => new EmailRenderError({ reason: "render-failed" }),
      try: render.bind(undefined, element, { plainText: false, pretty: false }),
    });

    yield* Schema.decodeEffect(EmailBodySchema)({ html }).pipe(
      Effect.mapError(() => new EmailRenderError({ reason: "invalid-output" })),
    );

    const text = yield* Effect.try({
      catch: () => new EmailRenderError({ reason: "render-failed" }),
      try: () => toPlainText(html),
    });

    const body = yield* RenderedReactEmailSchema.makeEffect({ html, text }).pipe(
      Effect.mapError(() => new EmailRenderError({ reason: "invalid-output" })),
    );

    return Object.freeze(body);
  },
  emailOperationSpan("ReactEmail.render"),
);
