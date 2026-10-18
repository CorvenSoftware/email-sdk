import { Effect, Redacted } from "effect";
import { defaultedIterableCampaignLayer } from "../src/iterable-campaign-defaults.js";
import { IterableCampaignEmail, iterableCampaignLayer } from "../src/iterable-campaign-email.js";

export const defaultedCampaignLayer = defaultedIterableCampaignLayer(
  iterableCampaignLayer({
    apiKey: Redacted.make("fictional-key"),
    campaignAuthority: "AuthorizeProviderManagedCampaign",
    contactWrites: "AuthorizeProfileCreation",
    dataRetention: "AuthorizePersistedSendData",
    projectIdentity: "EmailBased",
    region: "US",
    tracking: "AuthorizeCampaignTracking",
  }),
  { dataFields: { application: "fictional" }, metadata: { workflow: "fictional" } },
);

export const previewDefaultedCampaign = Effect.gen(function* previewDefaultedCampaign() {
  return yield* (yield* IterableCampaignEmail).validate({
    campaignId: 123,
    dataFields: { application: "operation override", enabled: false },
    recipientEmail: "recipient@fictional.invalid",
  });
});
