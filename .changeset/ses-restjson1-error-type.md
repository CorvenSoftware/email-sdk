---
"@corvencore/email-sdk": patch
---

Read SES refusal types per the AWS restJson1 contract: accept the type from `X-Amzn-Errortype`, `__type` or `code`, drop `:`-suffixed detail and `namespace#` prefixes, and accept a `Message` body field. A definite SES refusal such as `AccessDeniedException:http://internal.amazon.com/coral/...` is now an `EmailRejected` instead of an `EmailDeliveryUnknown`; conflicting or unsupported types remain unknown.
