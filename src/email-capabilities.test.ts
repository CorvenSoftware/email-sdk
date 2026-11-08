import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";
import {
  EmailSenderCapabilitiesSchema,
  intersectEmailSenderCapabilities,
} from "./email-capabilities.js";
import type { EmailSenderCapabilities } from "./email-capabilities.js";
import { syntheticEmailCapabilities } from "./email-synthetic-capabilities.js";

const attachmentSelections = [
  { attachmentContentTypes: "None", selections: [] },
  { attachmentContentTypes: "Explicit", selections: ["explicit"] },
  { attachmentContentTypes: "ProviderSelected", selections: ["provider"] },
  { attachmentContentTypes: "Both", selections: ["explicit", "provider"] },
] as const;

const headerMultiplicities = [
  { headers: "None", maximum: 0 },
  { headers: "Unique", maximum: 1 },
  { headers: "Repeated", maximum: Number.POSITIVE_INFINITY },
] as const;

const capabilitiesWithAttachments = (
  attachmentContentTypes: EmailSenderCapabilities["attachmentContentTypes"],
): EmailSenderCapabilities => ({
  ...syntheticEmailCapabilities,
  attachmentContentTypes,
  attachments: attachmentContentTypes !== "None",
  inlineAttachments: attachmentContentTypes !== "None",
});

describe("Routed capability intersection", () => {
  it("retains exactly the MIME selection authorities supported by both candidates", () => {
    for (const left of attachmentSelections) {
      for (const right of attachmentSelections) {
        const shared = intersectEmailSenderCapabilities([
          capabilitiesWithAttachments(left.attachmentContentTypes),
          capabilitiesWithAttachments(right.attachmentContentTypes),
        ]);

        const actual = attachmentSelections.find(
          (candidate) => candidate.attachmentContentTypes === shared.attachmentContentTypes,
        );

        assert.isDefined(actual);
        const rightSelections = new Set(right.selections);

        const expected = new Set(
          left.selections.filter((selection) => rightSelections.has(selection)),
        );

        assert.deepStrictEqual(new Set(actual.selections), expected);
        assert.strictEqual(shared.attachments, expected.size > 0);
        assert.strictEqual(shared.inlineAttachments, expected.size > 0);
        assert(Schema.is(EmailSenderCapabilitiesSchema)(shared));
      }
    }
  });

  it("limits header multiplicity to the least permissive candidate in either order", () => {
    for (const left of headerMultiplicities) {
      for (const right of headerMultiplicities) {
        const shared = intersectEmailSenderCapabilities([
          { ...syntheticEmailCapabilities, headers: left.headers },
          { ...syntheticEmailCapabilities, headers: right.headers },
        ]);

        const actual = headerMultiplicities.find(
          (candidate) => candidate.headers === shared.headers,
        );

        assert.isDefined(actual);
        assert.strictEqual(actual.maximum, Math.min(left.maximum, right.maximum));
      }
    }
  });
});
