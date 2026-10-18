---
title: Invoice due
description: Render an invoice amount, due date and trusted review link.
---

This application recipe uses the [shared transactional layout](/ui/components#shared-recipe-layout). It returns a rendering Effect containing HTML and plain text; it does not submit email or implement the business operation.

<include lang="ts">/_examples/react-invoice-due.ts.template</include>

## Supply authorized data

Validate payment-link origins and the recipient relationship to the invoice. Retain invoice identity and the reminder event separately so retries do not create duplicate billing actions.

Keep URLs and template inputs under host control. React text escaping is not URL validation or a consent check. Treat the rendered body as private message content.

## Send the rendered body

Yield the rendering Effect in your application, then supply its body to `Email.send` with explicit sender and recipients. Apply ordinary [provider validation](/providers/capabilities), [submission policy](/reference/options) and any required approval. The [React integration](/integrations/react) shows this composition.

These recipes are application examples, not additional template exports from the SDK. Rendering and compilation do not establish delivery or compatibility with every email client.
