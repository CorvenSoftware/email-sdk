---
title: corven-email providers
description: List implemented credential-free local inspection profiles and their declared capabilities.
---

```sh
corven-email providers
```

The report identifies selected local profiles and their capability declarations. Current implemented profiles are Resend, Postmark, SendGrid, Mailgun, MailerSend, MailPace and Unosend.

This is a narrower set than the package's [sending integrations](/providers). Absence from this command does not mean a provider Layer is missing, and presence does not prove any account has been authenticated.

## Apply a profile

Pass a supported lowercase profile name to `corven-email validate`, such as `resend` or `postmark`. The validator checks actual local provider rules in addition to common input decoding.

Profiles do not acquire credentials, HTTP clients or remote settings. Account-dependent modes and native Loops/Iterable jobs are not represented by this command. Use the configured service's `validate` method when its actual account or mode affects support.

See [capabilities and preflight](/providers/capabilities) before interpreting a capability flag as sendability.
