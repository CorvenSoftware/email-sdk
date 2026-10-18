---
title: Password reset
description: Render a password-reset link with an explicit expiry and host-owned token lifecycle.
---

This application recipe uses the [shared transactional layout](/ui/components#shared-recipe-layout). It returns a rendering Effect containing HTML and plain text; it does not submit email or implement the business operation.

<include lang="ts">/_examples/react-password-reset.ts.template</include>

## Supply authorized data

Generate a short-lived, single-use reset token in the host. Validate the destination origin, bind the request to the account and invalidate the token after use. Rendering does not implement authentication or token storage.

Keep URLs and template inputs under host control. React text escaping is not URL validation or a consent check. Treat the rendered body as private message content.

## Send the rendered body

Yield the rendering Effect in your application, then supply its body to `Email.send` with explicit sender and recipients. Apply ordinary [provider validation](/providers/capabilities), [submission policy](/reference/options) and any required approval. The [React integration](/integrations/react) shows this composition.

These recipes are application examples, not additional template exports from the SDK. Rendering and compilation do not establish delivery or compatibility with every email client.
