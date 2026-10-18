---
title: Privacy and diagnostics
description: Keep credentials and private message data out of diagnostics while selecting capture and telemetry deliberately.
---

The SDK does not install an analytics exporter, discover credentials or send import-time telemetry. Applications still need to control their transport logs, callbacks, framework histories and provider settings.

## Separate data channels

| Data                                                    | Intended destination                                                         |
| ------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Message body, recipients and supported message metadata | The selected provider, as explicit send intent                               |
| `executionMetadata`                                     | Private application preparation, approval and complete operation observation |
| Minimal submission observations                         | Bounded provider/outcome categories without payloads                         |
| Explicit payload capture                                | Authorized private application storage with retention limits                 |

SDK diagnostics and spans exclude original provider payloads, credentials, keys, message content and original private defects. Safe issue paths help identify a field without echoing its value. Do not add sensitive values to span names, route names or provider labels.

## Control the surrounding runtime

Disable automatic redirects, hidden mutation retries and sensitive logging in supplied transports. Review provider-side tracking, copies, rendering, profile writes and retention before making configuration attestations.

AI frameworks can retain tool inputs and histories even when the SDK's own output is minimal. Keep secrets and private content out of model context unless your application has explicitly authorized that disclosure.

## Capture is an explicit choice

Payload capture requires permission and byte/count bounds. Define access controls and an expiry policy before enabling it. Purging a view does not erase snapshots that escaped to callers or reset replay evidence. Read [capture](/composition/capture) before using it as an audit source.
