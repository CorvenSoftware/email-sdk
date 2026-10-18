import { createElement } from "react";
import type { ComponentPropsWithoutRef, CSSProperties, ReactElement } from "react";

import { reactEmailTheme } from "./email-react-theme.js";
import type { ReactEmailTheme, ReactEmailThemePreset } from "./email-react-theme.js";

export type ReactEmailDocumentProps = ComponentPropsWithoutRef<"html"> & {
  readonly preview?: string;
  readonly bodyStyle?: CSSProperties;
};

export type ReactEmailCardProps = ComponentPropsWithoutRef<"table">;

export type ReactEmailHeadingProps = ComponentPropsWithoutRef<"h1"> & {
  readonly level?: 1 | 2 | 3;
};

export type ReactEmailParagraphProps = ComponentPropsWithoutRef<"p"> & {
  readonly tone?: "normal" | "muted";
};

export type ReactEmailActionProps = ComponentPropsWithoutRef<"a"> & {
  readonly href: string;
  readonly variant?: "solid" | "outline";
};

export type ReactEmailDividerProps = ComponentPropsWithoutRef<"hr">;

export interface ReactEmailComponents {
  readonly EmailDocument: (props: ReactEmailDocumentProps) => ReactElement;
  readonly EmailCard: (props: ReactEmailCardProps) => ReactElement;
  readonly EmailHeading: (props: ReactEmailHeadingProps) => ReactElement;
  readonly EmailParagraph: (props: ReactEmailParagraphProps) => ReactElement;
  readonly EmailAction: (props: ReactEmailActionProps) => ReactElement;
  readonly EmailDivider: (props: ReactEmailDividerProps) => ReactElement;
}

export const themedReactEmailComponents = (
  input: ReactEmailTheme | ReactEmailThemePreset = "light",
): ReactEmailComponents => {
  const theme =
    input === "light" || input === "dark"
      ? reactEmailTheme(input)
      : reactEmailTheme("light", input);

  const EmailDocument = ({
    children,
    preview,
    bodyStyle,
    lang = "en",
    ...props
  }: ReactEmailDocumentProps): ReactElement =>
    createElement(
      "html",
      { ...props, lang },
      createElement(
        "head",
        null,
        createElement("meta", { charSet: "utf-8" }),
        createElement("meta", { content: "width=device-width, initial-scale=1", name: "viewport" }),
      ),
      createElement(
        "body",
        {
          style: {
            backgroundColor: theme.background,
            color: theme.foreground,
            fontFamily: theme.fontFamily,
            margin: 0,
            padding: "24px 12px",
            ...bodyStyle,
          },
        },
        preview === undefined
          ? null
          : createElement(
              "div",
              {
                "aria-hidden": true,
                "data-skip-in-text": "true",
                style: {
                  display: "none",
                  fontSize: "1px",
                  lineHeight: "1px",
                  maxHeight: 0,
                  maxWidth: 0,
                  opacity: 0,
                  overflow: "hidden",
                },
              },
              preview,
            ),
        children,
      ),
    );

  const EmailCard = ({ children, style, ...props }: ReactEmailCardProps): ReactElement =>
    createElement(
      "table",
      {
        cellPadding: 0,
        cellSpacing: 0,
        role: "presentation",
        ...props,
        style: {
          backgroundColor: theme.surface,
          border: `1px solid ${theme.border}`,
          borderRadius: theme.radius,
          color: theme.surfaceForeground,
          margin: "0 auto",
          maxWidth: "600px",
          width: "100%",
          ...style,
        },
      },
      createElement(
        "tbody",
        null,
        createElement("tr", null, createElement("td", { style: { padding: "24px" } }, children)),
      ),
    );

  const EmailHeading = ({ level = 1, style, ...props }: ReactEmailHeadingProps): ReactElement =>
    createElement({ 1: "h1", 2: "h2", 3: "h3" }[level], {
      ...props,
      style: {
        color: theme.surfaceForeground,
        fontSize: { 1: "28px", 2: "24px", 3: "20px" }[level],
        fontWeight: 700,
        lineHeight: 1.3,
        margin: "24px 0 12px",
        ...style,
      },
    });

  const EmailParagraph = ({
    tone = "normal",
    style,
    ...props
  }: ReactEmailParagraphProps): ReactElement =>
    createElement("p", {
      ...props,
      style: {
        color: tone === "muted" ? theme.mutedForeground : theme.surfaceForeground,
        fontSize: "16px",
        lineHeight: "24px",
        margin: "0 0 16px",
        ...style,
      },
    });

  const EmailAction = ({
    variant = "solid",
    style,
    ...props
  }: ReactEmailActionProps): ReactElement =>
    createElement("a", {
      ...props,
      style: {
        backgroundColor: variant === "solid" ? theme.accent : "transparent",
        border: `1px solid ${variant === "solid" ? theme.accent : theme.border}`,
        borderRadius: theme.radius,
        color: variant === "solid" ? theme.accentForeground : theme.surfaceForeground,
        display: "inline-block",
        fontSize: "16px",
        fontWeight: 600,
        lineHeight: "24px",
        padding: "12px 18px",
        textDecoration: "none",
        ...style,
      },
    });

  const EmailDivider = ({ style, ...props }: ReactEmailDividerProps): ReactElement =>
    createElement("hr", {
      ...props,
      style: { border: 0, borderTop: `1px solid ${theme.border}`, margin: "24px 0", ...style },
    });

  return Object.freeze({
    EmailAction,
    EmailCard,
    EmailDivider,
    EmailDocument,
    EmailHeading,
    EmailParagraph,
  });
};
