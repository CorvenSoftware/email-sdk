---
title: Render React email
description: Render trusted React elements into validated HTML and text before provider submission.
---

Import `renderReactEmail`, `reactEmailTheme` and `themedReactEmailComponents` from `@corvencore/email-sdk/react`. Install the [matching optional peers](/getting-started/installation#add-react-rendering); core sending and the CLI do not require React.

<include lang="ts">/_examples/react-components.ts.template</include>

The program renders a body, then uses ordinary `Email.send`. Provide an `Email` Layer before execution. Rendering itself does not submit email.

## Output and failures

`renderReactEmail(element)` returns an Effect containing a frozen `{ html, text }` body. It renders HTML, derives plain text and validates the common body contract. `EmailRenderError.reason` is `invalid-template`, `render-failed` or `invalid-output`; failures do not expose original renderer diagnostics.

## Trusted application code

Components are host code and can run their own side effects. Rendering does not sanitize untrusted HTML, approve recipients or validate URL schemes. Build templates from trusted elements and authorized data; apply link and privacy rules in the host.

Interruption stops awaiting the native renderer, but cannot physically cancel component work. Keep that limit in request and approval deadlines.

Use the [component reference](/ui/components), [theme guide](/ui/themes) and [template recipes](/ui) for application layouts. Always preflight the resulting body for the selected provider; rendering success does not establish provider acceptance or email-client compatibility.
