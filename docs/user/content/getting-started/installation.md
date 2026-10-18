---
title: Installation and runtime
description: Install the local package, choose ESM or CommonJS loading and add optional rendering peers only when needed.
---

Use Node.js **{{nodeVersion}}** and Effect **{{effectVersion}}**. The SDK is currently distributed from a local checkout. Follow the [quickstart](/quickstart#1-install-the-package) to build a tarball and install it into your application.

## Choose an entrypoint

Import `Email` and common message types from `@corven/email-sdk`. Import provider Layers from their explicit subpaths, such as `@corven/email-sdk/resend`. Optional rendering, agent and webhook integrations have their own entrypoints; [package reference](/reference) lists their purposes.

The package is ESM. On supported Node versions, synchronous CommonJS consumers can load the same ESM graph. There is no separate CommonJS build and no compatibility guarantee for older Node, browsers, Bun or edge runtimes. In particular, an HTTP provider name does not prove that the whole package can run in a Worker.

## Add React rendering

Core sending does not require React. For `@corven/email-sdk/react`, install the matching optional peers:

```sh
pnpm add react@{{reactVersion}} react-dom@{{reactDomVersion}} @react-email/render@{{reactEmailRenderVersion}}
```

TypeScript applications using React also need compatible React declarations. See [React rendering](/integrations/react).

## Keep the package boundary intact

Use exported subpaths rather than importing internal `dist/` files. Installed declarations describe the exact Effect errors and service requirements. Keep those requirements visible until your application provides the corresponding Layers.
