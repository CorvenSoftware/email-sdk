---
title: React email components
description: Use the document, card, heading, paragraph, action and divider components returned by a theme factory.
---

`themedReactEmailComponents(themeOrPreset?)` returns a component family. Pass `"light"`, `"dark"` or a `ReactEmailTheme`; the default preset is light.

| Component        | Special props                                         | Rendered structure                                                |
| ---------------- | ----------------------------------------------------- | ----------------------------------------------------------------- |
| `EmailDocument`  | `preview?`, `bodyStyle?`, HTML props including `lang` | HTML/head/body with theme styles and optional hidden preview text |
| `EmailCard`      | Table props including `style`                         | Presentation table containing the card content                    |
| `EmailHeading`   | `level?: 1 \| 2 \| 3`                                 | The corresponding heading element; level defaults to 1            |
| `EmailParagraph` | `tone?: "normal" \| "muted"`                          | Paragraph with normal or muted text styling                       |
| `EmailAction`    | Required `href`, `variant?: "solid" \| "outline"`     | Styled anchor; variant defaults to solid                          |
| `EmailDivider`   | Horizontal-rule props                                 | Themed separator                                                  |

Components also accept the corresponding native React element props. Style overrides are trusted host input, not sanitized design tokens. An action renders a link, not an authenticated operation.

## Shared recipe layout

The [template recipes](/ui) use this application helper to keep their structure consistent:

<include lang="ts">/_examples/react-layout.ts.template</include>

The helper is example code, not an SDK export. It creates trusted elements; `renderReactEmail` converts those elements into a body as shown in [React rendering](/integrations/react).

Hidden preview content is omitted from the renderer's plain-text conversion. Review both representations before submission. No component validates link origins, authorizes recipients or guarantees email-client rendering.
