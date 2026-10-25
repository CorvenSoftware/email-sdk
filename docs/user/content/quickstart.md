---
title: Quickstart
description: Install the SDK and record your first email without credentials or network calls.
---

Record a notification with the public `Email` service. This example uses an in-memory Layer, so you can run it without a provider account or HTTP client.

## Requirements

This guide covers SDK **{{sdkVersion}}** with Effect **{{effectVersion}}** on Node.js **{{nodeVersion}}**. The package supports ESM imports and Node's synchronous CommonJS loading of the same ESM graph. It does not ship a separate CommonJS bundle; older Node versions, browsers and edge runtimes are outside this runtime contract.

## 1. Install the package

Install the SDK and its matching Effect peer:

```sh
npm install @corvencore/email-sdk effect@{{effectVersion}}
```

If you use pnpm:

```sh
pnpm add @corvencore/email-sdk effect@{{effectVersion}}
```

No checkout or local package build is required.

## 2. Record an email

<include lang="ts">./_examples/recording.ts.template</include>

The program acquires `Email` to submit the message and `RecordedEmails` to inspect the recording. Providing `recordingEmailLayer` connects both services to the same in-memory store.

All addresses in these examples use the fictional `.test` domain.

## 3. Run and inspect the result

In your application's entrypoint, run `Effect.runPromise(recordNotification)`.

The result contains:

- `receipt`: a `Recorded` receipt identifying the local recording.
- `messages`: the messages recorded in that Layer acquisition.

The recording Layer stores messages in memory without contacting a provider. Use it to test application behavior. It does not persist a queue or confirm delivery. Acquire the recorder and its query service together. A new recording Layer has a separate store.

## Next steps

[Configure a provider](./sending) when you are ready to connect an account, or read [messages and attachments](./messages) to build richer content.
