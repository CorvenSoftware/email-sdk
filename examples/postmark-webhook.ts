import { Effect } from "effect";
import {
  PostmarkWebhookEventSchema,
  parsePostmarkWebhookEvent,
} from "../src/postmark-webhook-event.js";

export const parseIncomingPostmarkReport = Effect.fnUntraced(function* parseIncomingPostmarkReport(
  rawBody: string,
) {
  const event = yield* parsePostmarkWebhookEvent(rawBody);

  const category = PostmarkWebhookEventSchema.match(event, {
    BounceReported: () => "NativeBounceReport" as const,
    Bounced: () => "HardBounceReport" as const,
    Complained: () => "SpamComplaintReport" as const,
    Delivered: () => "RecipientServerAcceptanceReport" as const,
    Other: () => "UnclassifiedReport" as const,
  });

  return { category, provenance: event.provenance };
});
