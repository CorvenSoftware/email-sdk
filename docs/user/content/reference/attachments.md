---
title: Attachment reference
description: Construct canonical bounded attachments and preserve explicit MIME and inline-placement choices.
---

Import `EmailAttachmentSchema`, `EmailAttachmentInput`, `EmailAttachmentOptions` and the acquisition helpers from the root entrypoint.

| Helper                           | Supplied content           | Result                                               |
| -------------------------------- | -------------------------- | ---------------------------------------------------- |
| `emailAttachmentFromBytes`       | `Uint8Array` plus options  | Effect of `EmailAttachment` or `EmailInvalidMessage` |
| `emailAttachmentFromArrayBuffer` | `ArrayBuffer` plus options | Effect of `EmailAttachment` or `EmailInvalidMessage` |
| `emailAttachmentFromBlob`        | `Blob` plus options        | Effect of `EmailAttachment` or `EmailInvalidMessage` |

The application acquires files or URLs; helpers do not fetch or read paths.

## Fields and bounds

`filename` is a bounded ASCII basename, not a path. `contentType` is a lowercase MIME type/subtype without parameters or the literal `ProviderSelected`. `contentBase64` is canonical padded standard Base64 without whitespace or URL-safe characters.

Each attachment contains from one byte through one MiB of decoded content. A message permits at most ten attachments and four MiB of decoded attachment content. A provider can impose additional encoded message-size, extension or type limits.

Optional `contentId` is an unprefixed bounded ASCII identifier. Explicit `disposition: "inline"` requires it; `disposition: "attachment"` forbids it. IDs must be distinct within a message. Provider-specific CID constraints can be stricter.

## Preserve MIME selection

Do not infer MIME from filenames or `Blob.type`. Choose `ProviderSelected` only for a compatible provider and a deliberate delegation. A provider requiring explicit MIME must refuse that delegation, and vice versa.

Interruption can stop awaiting a Blob read without physically cancelling it. Rendering an inline CID reference does not prove that the provider or every email client supports the placement. See [field support](/providers/field-support).
