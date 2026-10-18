---
title: Email UI and template recipes
description: Build transactional layouts from the SDK's themed React components and task-specific application recipes.
---

The optional React entrypoint supplies a small themed component family and a renderer. Start with [components](/ui/components) and [themes](/ui/themes), then adapt a recipe to your application's authorized data.

## Account messages

- [Verification code](/ui/verification-code): display a short-lived code and its expiry.
- [Password reset](/ui/password-reset): link to an application-owned reset flow.
- [Team invitation](/ui/team-invite): identify the inviter and destination team.

## Product notifications

- [Welcome](/ui/welcome): offer one useful first action.
- [Trial ending](/ui/trial-ending): state the deadline and link to plan settings.
- [Usage alert](/ui/usage-alert): show measured usage and the relevant limit.

## Billing messages

- [Payment receipt](/ui/receipt): describe an authoritative payment record.
- [Invoice due](/ui/invoice-due): show an amount, due date and trusted review link.
- [Refund confirmation](/ui/refund-confirmed): distinguish recorded refund state from settlement time.

These examples use public SDK components. Copy and adapt them in your application; they are not SDK template exports. They return HTML and text bodies for [sending](/integrations/react). They do not implement authentication, billing or consent, and they do not send email.

## Review rendered messages

Keep template code, links and business decisions trusted. Review plain text as well as HTML, and inspect the result in the email clients your audience uses. Compilation and rendering do not prove client compatibility, accessibility in every inbox or delivery. The SDK does not host previews or collect message content for analytics.
