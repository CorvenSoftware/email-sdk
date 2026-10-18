---
title: Validation and verification boundaries
description: Distinguish local validation, synthetic tests, installed consumers, account authentication and real delivery.
---

The checks below verify different properties. Use the check that matches the property you need to verify.

| Evidence                     | What it establishes                                                 | What remains unknown                                |
| ---------------------------- | ------------------------------------------------------------------- | --------------------------------------------------- |
| Common message decoding      | Input shape and common refinements                                  | Provider support and remote permission              |
| Provider-local preflight     | Implemented provider constraints                                    | Credentials, account settings and remote acceptance |
| Synthetic service tests      | Application behavior under controlled outcomes                      | Real protocol or provider behavior                  |
| Local loopback wire tests    | Request/response and transport behavior against a local fixture     | Live authentication and delivery                    |
| Installed-consumer checks    | Shipped exports, declarations and selected runtime interoperability | Every bundler/runtime and live account              |
| Explicit live authentication | The scoped account/authentication operation checked                 | General sending permission and delivery             |
| Provider acceptance          | Acknowledgment of a submission                                      | Recipient receipt or inbox placement                |

## Use offline checks first

Start with [recording and failing services](/guides/testing). Validate the complete message against the selected provider. Compile public-import examples in your application's actual TypeScript and optional-framework versions.

The CLI is offline. It has no live doctor or send command. If credentials are unavailable, authentication has not been checked.

## Keep live probes controlled

Before a live check, specify the account, destination, credentials, permitted data, expected cost and cleanup. Use fictional addresses in offline tests. Check submission and delivery separately. A receipt or parsed webhook does not verify all provider behavior.
