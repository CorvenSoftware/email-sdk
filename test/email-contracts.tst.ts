import { expectTypeOf } from "vitest";
import { createElement } from "react";
import {
  reactEmailTheme,
  renderReactEmail,
  themedReactEmailComponents,
} from "../src/email-react.js";
import type { EmailRenderError, ReactEmailTheme, RenderedReactEmail } from "../src/email-react.js";
import { DateTime, Duration, Effect, Layer, Predicate, Redacted, Schema } from "effect";
import type { Result, Scope } from "effect";
import type { InferToolInput, InferToolOutput, ToolSet } from "ai";
import { emailAiTool } from "../src/email-ai-tool.js";
import type { EmailAiReceipt, EmailAiRunner, EmailAiTool } from "../src/email-ai-tool.js";
import type { HttpClient } from "effect/http";
import { defineEmailHttpProvider, EmailHttpCredentialSchema } from "../src/email-provider.js";
import type { EmailHttpExchange, EmailProviderProfile } from "../src/email-provider.js";
import {
  Email,
  EmailSender,
  EmailRejected,
  emailAttachmentFromBytes,
  emailAttachmentFromArrayBuffer,
  emailAttachmentFromBlob,
  renderEmailPersonalizedMessage,
  EmailAddressSchema,
  EmailIdempotencyKeySchema,
  EmailMessageIdSchema,
  EmailSubmissionIdSchema,
  EmailReceiptSchema,
  EmailRecipientOutcomeSchema,
  EmailRouter,
  emailRouterLayer,
  emailLayer,
  transformedEmailLayer,
  observedEmailOperationLayer,
  capturedEmailRouterLayer,
  observedEmailRouterLayer,
  EmailOperationOutcomeSchema,
} from "../src/index.js";
import type {
  EmailConfigurationError,
  EmailAttachment,
  EmailInvalidMessage,
  EmailMessage,
  EmailMessageInput,
  EmailInvalidOptions,
  EmailReceipt,
  EmailSendError,
  IEmail,
  IEmailSender,
  IEmailRoute,
  EmailRoutedReceipt,
  EmailRetryDecision,
  EmailRetryObserver,
  EmailRetryRestriction,
  EmailRetryCandidate,
  EmailPreparedOperation,
  EmailMessageTransform,
  EmailMessageTransformInput,
  EmailExecutionMetadata,
  EmailOperationObserver,
  EmailRouteName,
  EmailIdempotencyKey,
} from "../src/index.js";
import { EmailAgent, EmailAgentApproval, emailAgentLayer } from "../src/email-agent.js";
import type {
  EmailAgentInput,
  EmailAgentProposal,
  IEmailAgent,
  IEmailAgentApproval,
  EmailAgentApprovalError,
} from "../src/email-agent.js";
import { defaultedEmailLayer } from "../src/email-defaults.js";
import type { EmailDefaultsInput } from "../src/email-defaults.js";
import {
  aggregatedEmailCaptureLayer,
  capturedEmailSenderLayer,
} from "../src/email-submission-capture.js";
import type {
  EmailSubmissionCapture,
  EmailCaptureSnapshot,
  EmailCapturePayload,
  EmailCaptureRecord,
  IEmailSubmissionCapture,
  EmailCaptureAggregate,
  EmailCaptureAggregateSnapshot,
  EmailCaptureAggregateError,
  IEmailCaptureAggregate,
  EmailCaptureBinding,
} from "../src/email-submission-capture.js";
import {
  observedEmailSenderLayer,
  aggregatedEmailObservationsLayer,
  EmailObservationAggregateSourceSchema,
} from "../src/email-submission-observations.js";
import type {
  EmailSubmissionObservation,
  EmailSubmissionStarting,
  EmailSubmissionStartingObserver,
  EmailSubmissionObserver,
  EmailSubmissionObservationSnapshot,
  IEmailSubmissionObservations,
  EmailSubmissionObservations,
  IEmailObservationAggregate,
  EmailObservationAggregate,
  EmailObservationAggregateSnapshot,
  EmailObservationAggregateError,
  EmailObservationBinding,
} from "../src/email-submission-observations.js";
import {
  preflightResendEmail,
  resendEmailLayer,
  resendSenderLayer,
} from "../src/resend-email-sender.js";
import { preflightPostmarkEmail, postmarkEmailLayer } from "../src/postmark-email-sender.js";
import {
  sendgridEmailLayer,
  sendgridPersonalizedEmailLayer,
  preflightSendgridEmail,
} from "../src/sendgrid-email-sender.js";
import {
  preflightMailgunEmail,
  mailgunEmailLayer,
  mailgunPersonalizedEmailLayer,
} from "../src/mailgun-email-sender.js";
import { preflightMailersendEmail, mailersendEmailLayer } from "../src/mailersend-email-sender.js";
import { preflightMailpaceEmail, mailpaceEmailLayer } from "../src/mailpace-email-sender.js";
import { preflightUnosendEmail, unosendEmailLayer } from "../src/unosend-email-sender.js";
import { lettermintEmailLayer } from "../src/lettermint-email-sender.js";
import { plunkEmailLayer } from "../src/plunk-email-sender.js";
import { heloEmailLayer } from "../src/helo-email-sender.js";
import { jetemailEmailLayer } from "../src/jetemail-email-sender.js";
import { lettrEmailLayer } from "../src/lettr-email-sender.js";
import { sparkpostEmailLayer } from "../src/sparkpost-email-sender.js";
import { primitiveEmailLayer } from "../src/primitive-email-sender.js";
import { mailtrapEmailLayer } from "../src/mailtrap-email-sender.js";
import { mailchimpEmailLayer } from "../src/mailchimp-email-sender.js";
import type { MailchimpTagStatisticsInput } from "../src/mailchimp-email-sender.js";
import { scalewayEmailLayer } from "../src/scaleway-email-sender.js";
import { zeptomailEmailLayer } from "../src/zeptomail-email-sender.js";
import { graphEmailLayer, graphSenderLayer } from "../src/graph-email-sender.js";
import { cloudflareEmailLayer, cloudflareSenderLayer } from "../src/cloudflare-email-sender.js";
import { sesEmailLayer, sesSenderLayer } from "../src/ses-email-sender.js";
import {
  SmtpAuthenticationSchema,
  smtpEmailLayer,
  smtpSenderLayer,
} from "../src/smtp-email-sender.js";
import {
  LoopsTransactionalEmail,
  loopsTransactionalLayer,
} from "../src/loops-transactional-email.js";
import { defaultedLoopsTransactionalLayer } from "../src/loops-transactional-defaults.js";
import type { LoopsTransactionalDefaultsInput } from "../src/loops-transactional-defaults.js";
import { brevoEmailLayer } from "../src/brevo-email-sender.js";
import { sequenzyEmailLayer } from "../src/sequenzy-email-sender.js";
import { sendheronEmailLayer } from "../src/sendheron-email-sender.js";
import { IterableCampaignEmail, iterableCampaignLayer } from "../src/iterable-campaign-email.js";
import {
  capturedLoopsTransactionalLayer,
  capturedIterableCampaignLayer,
} from "../src/email-native-capture.js";
import type {
  EmailNativeCapturePayload,
  IEmailNativeCapture,
  EmailNativeCapture,
} from "../src/email-native-capture.js";
import {
  observedLoopsTransactionalLayer,
  observedIterableCampaignLayer,
} from "../src/email-native-observations.js";
import type {
  IEmailNativeObservations,
  EmailNativeObserver,
  EmailNativeOperationStarting,
  EmailNativeStartingObserver,
  EmailNativeObservationSnapshot,
  EmailNativeObservations,
} from "../src/email-native-observations.js";
import { defaultedIterableCampaignLayer } from "../src/iterable-campaign-defaults.js";
import type { IterableCampaignDefaultsInput } from "../src/iterable-campaign-defaults.js";
import type {
  IIterableCampaignEmail,
  IterableCampaignJob,
} from "../src/iterable-campaign-email.js";
import type {
  ILoopsTransactionalEmail,
  LoopsTransactionalJob,
} from "../src/loops-transactional-email.js";
import {
  MailgunWebhookEventSchema,
  MailgunWebhookRecipientSchema,
  mailgunWebhookLayer,
  parseMailgunWebhookEvent,
} from "../src/mailgun-webhook-verifier.js";
import type {
  MailgunWebhookEvent,
  IMailgunWebhookVerifier,
  MailgunWebhookVerifier,
  VerifiedMailgunWebhookSignature,
} from "../src/mailgun-webhook-verifier.js";
import {
  resendWebhookLayer,
  parseResendWebhookEvent,
  ResendWebhookEventSchema,
} from "../src/resend-webhook-verifier.js";
import type {
  EmailWebhookVerificationError,
  EmailWebhookNormalizationError,
  ResendWebhookEvent,
  IResendWebhookVerifier,
  ResendWebhookVerifier,
  VerifiedResendWebhook,
} from "../src/resend-webhook-verifier.js";
import {
  parsePostmarkWebhookEvent,
  PostmarkWebhookEventSchema,
} from "../src/postmark-webhook-event.js";
import type { PostmarkWebhookEvent } from "../src/postmark-webhook-event.js";
import { recordingEmailLayer, recordingSenderLayer } from "../src/recording-email-sender.js";
import { failingEmailLayer } from "../src/email-testing.js";
import type { IRecordedEmails } from "../src/recording-email-sender.js";

const message = {
  body: { html: "<p>Synthetic</p>", text: "Synthetic" },
  from: "sender@example.test",
  subject: "Example",
  to: ["recipient@example.test"],
} as const;

export const proveRecordedEmailsCallSites = (records: IRecordedEmails): void => {
  expectTypeOf(records.purgeMessages).toEqualTypeOf<Effect.Effect<number>>();
  // @ts-expect-error -- Purge is a lazy Effect, not a replay-reset operation with flags.
  void records.purgeMessages({ resetKeys: true });
  // @ts-expect-error -- The acquired purge capability remains readonly.
  records.purgeMessages = Effect.succeed(0);
};

export const proveEmailAgentCallSites = (
  agent: IEmailAgent,
  review: IEmailAgentApproval,
  input: EmailAgentInput,
  proposal: EmailAgentProposal,
): void => {
  expectTypeOf(emailAgentLayer({ from: "host@example.test" })).toEqualTypeOf<
    Layer.Layer<EmailAgent, EmailConfigurationError, Email | EmailAgentApproval>
  >();
  expectTypeOf(agent.submit(input, { idempotencyKey: "host-key" })).toEqualTypeOf<
    Effect.Effect<EmailReceipt, EmailSendError | EmailAgentApprovalError>
  >();
  expectTypeOf(review.review(proposal)).toEqualTypeOf<
    Effect.Effect<"Approved" | "Declined", EmailAgentApprovalError>
  >();
  // @ts-expect-error -- A model cannot replace the host-owned sender.
  void agent.submit({ ...input, from: "model@example.test" });
  // @ts-expect-error -- Approval and idempotency are not model input.
  void agent.submit({ ...input, approved: true, idempotencyKey: "model-key" });
  // @ts-expect-error -- A boolean is not an explicit approval decision.
  void EmailAgentApproval.of({ review: () => Effect.succeed(true) });
  // @ts-expect-error -- Reviewed content is readonly.
  proposal.message.subject = "changed";
  // @ts-expect-error -- Host operation options cannot be altered by a reviewer.
  proposal.options.idempotencyKey = "changed";

  const pending = EmailAgent.pipe(
    Effect.flatMap((provided) => provided.submit(input)),
    Effect.provide(
      emailAgentLayer({ from: "host@example.test" }).pipe(Layer.provide(recordingEmailLayer)),
    ),
  );

  expectTypeOf(pending).toEqualTypeOf<
    Effect.Effect<
      EmailReceipt,
      EmailSendError | EmailAgentApprovalError | EmailConfigurationError,
      EmailAgentApproval
    >
  >();
};

export const proveEmailDefaultsCallSites = (defaults: EmailDefaultsInput): void => {
  expectTypeOf(
    defaultedEmailLayer(resendEmailLayer({ apiKey: Redacted.make("fictional-key") }), defaults),
  ).toEqualTypeOf<Layer.Layer<Email, EmailConfigurationError, HttpClient.HttpClient>>();
  expectTypeOf(defaultedEmailLayer(recordingEmailLayer, defaults)).toEqualTypeOf<
    Layer.Layer<Email, EmailConfigurationError>
  >();
  // @ts-expect-error -- Defaults decorate Email, not the lower-level transport authority.
  void defaultedEmailLayer(recordingSenderLayer, {});
  // @ts-expect-error -- Defaults do not silently replace explicit sender intent.
  void defaultedEmailLayer(recordingEmailLayer, { from: "default@example.test" });
  // @ts-expect-error -- A shared default key could deduplicate different logical messages.
  void defaultedEmailLayer(recordingEmailLayer, { idempotencyKey: "shared-key" });
  // @ts-expect-error -- Default metadata retains the common string-only contract.
  void defaultedEmailLayer(recordingEmailLayer, { metadata: { count: 1 } });
  // @ts-expect-error -- Configuration ownership is readonly to callers.
  defaults.idempotencyKeyPrefix = "changed/";
};

export const proveEmailCaptureCallSites = (
  view: IEmailSubmissionCapture,
  snapshot: EmailCaptureSnapshot,
  record: EmailCaptureRecord,
): void => {
  expectTypeOf(view.snapshot).toEqualTypeOf<Effect.Effect<EmailCaptureSnapshot>>();
  expectTypeOf(view.purgeRecords).toEqualTypeOf<Effect.Effect<number>>();
  // @ts-expect-error -- Purge cannot accept replay-reset or history-reset flags.
  void view.purgeRecords({ resetKeys: true });
  // @ts-expect-error -- The acquired retention-control capability remains readonly.
  view.purgeRecords = Effect.succeed(0);
  expectTypeOf(
    capturedEmailSenderLayer(resendSenderLayer({ apiKey: Redacted.make("fictional-key") }), {
      capacity: 10,
      maxBytes: 4096,
      privateData: "AuthorizePayloadCapture",
    }),
  ).toEqualTypeOf<
    Layer.Layer<
      EmailSender | EmailSubmissionCapture,
      EmailConfigurationError,
      HttpClient.HttpClient
    >
  >();
  // @ts-expect-error -- Payload capture requires explicit host permission and bounds.
  void capturedEmailSenderLayer(recordingSenderLayer, { capacity: 10, maxBytes: 4096 });
  // @ts-expect-error -- Capture consumes the actual sender capability, not unrelated Layers.
  void capturedEmailSenderLayer(Layer.empty, {
    capacity: 10,
    maxBytes: 4096,
    privateData: "AuthorizePayloadCapture",
  });
  // @ts-expect-error -- Captured private payloads are never exposed as ordinary strings.
  const json: string = record.payloadJson;
  // @ts-expect-error -- Capture snapshots cannot reset retained state.
  snapshot.records.length = 0;
  // @ts-expect-error -- Capture exposes no underlying replay reset.
  void view.clear;
  void json;
};

const failingEmailObserver = () =>
  Effect.fail(new EmailRejected({ provider: "fixture", reason: "rejected" }));

const requiringEmailObserver = () => Effect.asVoid(Email);

const requiringEmailRetryRestriction = () => Effect.as(Email, true);

const synchronousEmailRetryRestriction = () => true;

export const proveEmailRetryCallSites = (
  observer: EmailRetryObserver,
  decision: EmailRetryDecision,
  restriction: EmailRetryRestriction,
  candidate: EmailRetryCandidate,
): void => {
  expectTypeOf(emailLayer(undefined, observer, restriction)).toEqualTypeOf<
    Layer.Layer<Email, EmailConfigurationError, EmailSender>
  >();
  expectTypeOf(
    resendEmailLayer({ apiKey: Redacted.make("fictional-key") }, undefined, observer, restriction),
  ).toEqualTypeOf<Layer.Layer<Email, EmailConfigurationError, HttpClient.HttpClient>>();
  expectTypeOf(
    loopsTransactionalLayer(
      {
        apiKey: Redacted.make("fictional-key"),
        attachments: "Disabled",
        templateAuthority: "ProviderManaged",
      },
      undefined,
      observer,
      restriction,
    ),
  ).toEqualTypeOf<
    Layer.Layer<LoopsTransactionalEmail, EmailConfigurationError, HttpClient.HttpClient>
  >();
  expectTypeOf(
    iterableCampaignLayer(
      {
        apiKey: Redacted.make("fictional-key"),
        campaignAuthority: "AuthorizeProviderManagedCampaign",
        contactWrites: "AuthorizeProfileCreation",
        dataRetention: "AuthorizePersistedSendData",
        projectIdentity: "EmailBased",
        region: "US",
        tracking: "AuthorizeCampaignTracking",
      },
      undefined,
      observer,
      restriction,
    ),
  ).toEqualTypeOf<
    Layer.Layer<IterableCampaignEmail, EmailConfigurationError, HttpClient.HttpClient>
  >();
  expectTypeOf(failingEmailObserver).not.toExtend<EmailRetryObserver>();
  expectTypeOf(requiringEmailObserver).not.toExtend<EmailRetryObserver>();
  expectTypeOf<EmailSubmissionObserver>().not.toExtend<EmailRetryObserver>();
  expectTypeOf<EmailNativeObserver>().not.toExtend<EmailRetryObserver>();
  expectTypeOf(failingEmailObserver).not.toExtend<EmailRetryRestriction>();
  expectTypeOf(requiringEmailRetryRestriction).not.toExtend<EmailRetryRestriction>();
  expectTypeOf(synchronousEmailRetryRestriction).not.toExtend<EmailRetryRestriction>();
  expectTypeOf<EmailRetryObserver>().not.toExtend<EmailRetryRestriction>();
  expectTypeOf<EmailRetryRestriction>().not.toExtend<EmailRetryObserver>();
  expectTypeOf<EmailRetryCandidate>().not.toExtend<EmailRetryDecision>();
  void emailLayer({
    deadline: Duration.seconds(1),
    initialDelay: Duration.millis(1),
    maxAttempts: 2,
    // @ts-expect-error -- Retry restrictions are host Effects, never serialized policy.
    shouldRetry: restriction,
  });
  void emailLayer({
    deadline: Duration.seconds(1),
    initialDelay: Duration.millis(1),
    maxAttempts: 2,
    // @ts-expect-error -- Retry callbacks are host code, not a serialized policy field.
    onRetry: observer,
  });
  // @ts-expect-error -- Candidate proposals have readonly operation-local ordinals.
  candidate.nextAttempt = 2;
  // @ts-expect-error -- Restriction proposals do not expose private intent.
  void candidate.message;
  // @ts-expect-error -- Retry facts have readonly operation-local attempt numbering.
  decision.attempt = 2;
  // @ts-expect-error -- Retry decisions do not contain private message payloads.
  void decision.message;
  // @ts-expect-error -- Retry decisions do not contain original modeled errors or defects.
  void decision.error;
  // @ts-expect-error -- An upcoming retry is not provider acceptance or delivery evidence.
  const receipt: EmailReceipt = decision;
  void receipt;
};

export const proveEmailObservationCallSites = (
  view: IEmailSubmissionObservations,
  snapshot: EmailSubmissionObservationSnapshot,
  observation: EmailSubmissionObservation,
  observer: EmailSubmissionObserver,
  starting: EmailSubmissionStarting,
  startingObserver: EmailSubmissionStartingObserver,
): void => {
  expectTypeOf(view.snapshot).toEqualTypeOf<Effect.Effect<EmailSubmissionObservationSnapshot>>();
  expectTypeOf(
    observedEmailSenderLayer(
      resendSenderLayer({ apiKey: Redacted.make("fictional-key") }),
      {
        capacity: 10,
      },
      observer,
      startingObserver,
    ),
  ).toEqualTypeOf<
    Layer.Layer<
      EmailSender | EmailSubmissionObservations,
      EmailConfigurationError,
      HttpClient.HttpClient
    >
  >();

  // @ts-expect-error -- Observation composition requires an actual sender Layer.
  void observedEmailSenderLayer(Layer.empty);
  // @ts-expect-error -- Callback code is a distinct Effect argument, not an options field.
  void observedEmailSenderLayer(recordingSenderLayer, { onReceipt: () => Effect.void });

  expectTypeOf(failingEmailObserver).not.toExtend<EmailSubmissionObserver>();
  expectTypeOf(requiringEmailObserver).not.toExtend<EmailSubmissionObserver>();
  expectTypeOf(failingEmailObserver).not.toExtend<EmailSubmissionStartingObserver>();
  expectTypeOf(requiringEmailObserver).not.toExtend<EmailSubmissionStartingObserver>();
  expectTypeOf<EmailSubmissionObserver>().not.toExtend<EmailSubmissionStartingObserver>();
  expectTypeOf<EmailRetryObserver>().not.toExtend<EmailSubmissionStartingObserver>();
  // @ts-expect-error -- Starting notifications cannot replace the acquired provider label.
  starting.provider = "replacement";
  // @ts-expect-error -- Starting notifications disclose no private intent.
  void starting.message;
  // @ts-expect-error -- Starting callbacks are explicit host code, not serialized policy.
  void observedEmailSenderLayer(recordingSenderLayer, { onStarting: startingObserver });
  // @ts-expect-error -- Observation snapshots have readonly ownership.
  snapshot.truncated = true;
  // @ts-expect-error -- Observation arrays cannot be reset beneath in-flight submissions.
  snapshot.observations.length = 0;
  // @ts-expect-error -- Minimal attempt facts are not submission receipts.
  const receipt: EmailReceipt = observation;
  // @ts-expect-error -- Observation views retain no private message payload.
  void observation.message;
  // @ts-expect-error -- Observation views do not expose replay resets.
  void view.clear;
  void receipt;
};

export const provePostmarkEventCallSites = (
  event: PostmarkWebhookEvent,
  proof: VerifiedResendWebhook,
): void => {
  expectTypeOf(parsePostmarkWebhookEvent("raw JSON")).toEqualTypeOf<
    Effect.Effect<PostmarkWebhookEvent, EmailWebhookNormalizationError>
  >();
  expectTypeOf(event.provenance).toEqualTypeOf<"UnverifiedPayload">();
  // @ts-expect-error -- Payload projection cannot manufacture authenticated raw-body proof.
  const authenticated: VerifiedResendWebhook = event;
  // @ts-expect-error -- Unsigned reports are not outbound submission receipts.
  const receipt: EmailReceipt = event;
  // @ts-expect-error -- Body projection cannot enter the authenticated Resend parser.
  void parseResendWebhookEvent(event);
  // @ts-expect-error -- Postmark input is raw text, not a foreign provider proof.
  void parsePostmarkWebhookEvent(proof);
  // @ts-expect-error -- This body-only parser never invents a delivery identity.
  void event.deliveryId;

  if (PostmarkWebhookEventSchema.guards.Bounced(event)) {
    expectTypeOf(event.bounceType).toEqualTypeOf<"HardBounce">();
    expectTypeOf(event.bounceTypeCode).toEqualTypeOf<1>();
  }

  if (PostmarkWebhookEventSchema.guards.BounceReported(event)) {
    // @ts-expect-error -- Native reports retain readonly classification fields.
    event.bounceTypeCode = 1;
  }

  void authenticated;
  void receipt;
};

export const proveMailgunEventCallSites = (
  event: MailgunWebhookEvent,
  challenge: VerifiedMailgunWebhookSignature,
): void => {
  expectTypeOf(parseMailgunWebhookEvent("raw JSON")).toEqualTypeOf<
    Effect.Effect<MailgunWebhookEvent, EmailWebhookNormalizationError>
  >();
  expectTypeOf(event.provenance).toEqualTypeOf<"UnverifiedPayload">();
  // @ts-expect-error -- Challenge proof does not contain a raw event body.
  void parseMailgunWebhookEvent(challenge);
  // @ts-expect-error -- Unsigned event observations cannot authenticate a Resend body.
  void parseResendWebhookEvent(event);
  // @ts-expect-error -- Event IDs have provider-day scope, not a manufactured delivery identity.
  void event.deliveryId;
  // @ts-expect-error -- RFC header identity is not an automatically reconstructed submission handle.
  void event.providerMessageId;
  // @ts-expect-error -- Event data is not challenge verification proof.
  const proof: VerifiedMailgunWebhookSignature = event;
  // @ts-expect-error -- Event observations are not submission receipts.
  const receipt: EmailReceipt = event;

  // @ts-expect-error -- Native event and outbound submission IDs are distinct branded concepts.
  const submissionId: typeof EmailMessageIdSchema.Type = event.providerEventId;

  if (!MailgunWebhookEventSchema.guards.Other(event)) {
    // @ts-expect-error -- A reported RFC header does not become an outbound submission ID.
    const headerAsSubmission: typeof EmailMessageIdSchema.Type = event.rfcMessageId;
    void headerAsSubmission;

    if (MailgunWebhookRecipientSchema.guards.Redacted(event.recipient)) {
      // @ts-expect-error -- Redaction never provides an invented address.
      void event.recipient.address;
    } else {
      const { address } = event.recipient;
      // @ts-expect-error -- Reported recipient ownership is readonly.
      event.recipient.address = address;
    }
  }

  void proof;
  void receipt;
  void submissionId;
};

export const proveMailgunWebhookCallSites = (
  verifier: IMailgunWebhookVerifier,
  proof: VerifiedMailgunWebhookSignature,
): void => {
  expectTypeOf(
    mailgunWebhookLayer({
      signatureField: "signature",
      signingSecrets: [Redacted.make("fictional-unused-signing-key")],
    }),
  ).toEqualTypeOf<Layer.Layer<MailgunWebhookVerifier, EmailConfigurationError>>();
  expectTypeOf(
    verifier.verifySignature({
      signature: "00".repeat(32),
      timestamp: 1_791_849_600,
      token: "fictional-token",
    }),
  ).toEqualTypeOf<Effect.Effect<VerifiedMailgunWebhookSignature, EmailWebhookVerificationError>>();
  // @ts-expect-error -- Mailgun account signing authority must remain Redacted.
  void mailgunWebhookLayer({ signatureField: "signature", signingSecrets: ["unwrapped-key"] });
  // @ts-expect-error -- A caller must explicitly select primary or parent signing authority.
  void mailgunWebhookLayer({ signingSecrets: [Redacted.make("fictional-unused-signing-key")] });
  // @ts-expect-error -- Mailgun signing authority requires a nonempty rotation list.
  void mailgunWebhookLayer({ signatureField: "signature", signingSecrets: [] });
  // @ts-expect-error -- Mailgun does not authenticate the raw event body.
  void verifier.verifySignature({ body: "raw event", headers: [] });
  // @ts-expect-error -- Signature-only proof is not Resend authenticated-payload evidence.
  const payload: VerifiedResendWebhook = proof;
  // @ts-expect-error -- Signature-only results never expose an authenticated event body.
  void proof.body;

  // @ts-expect-error -- Plain signed fields cannot manufacture a verified challenge.
  const forged: VerifiedMailgunWebhookSignature = {
    signatureField: proof.signatureField,
    timestamp: proof.timestamp,
    token: proof.token,
  };

  void forged;
  void payload;
};

export const proveResendEventCallSites = (
  proof: VerifiedResendWebhook,
  challenge: VerifiedMailgunWebhookSignature,
  event: ResendWebhookEvent,
): void => {
  expectTypeOf(parseResendWebhookEvent(proof)).toEqualTypeOf<
    Effect.Effect<ResendWebhookEvent, EmailWebhookNormalizationError>
  >();
  // @ts-expect-error -- Raw fields cannot stand in for authenticated Resend proof.
  void parseResendWebhookEvent({ body: proof.body, id: proof.id, timestamp: proof.timestamp });
  // @ts-expect-error -- Mailgun challenge verification never authenticates an event body.
  void parseResendWebhookEvent(challenge);
  // @ts-expect-error -- Delivery reports are not outgoing submission receipts.
  const receipt: EmailReceipt = event;
  void receipt;

  if (ResendWebhookEventSchema.guards.Other(event)) {
    // @ts-expect-error -- Unclassified events cannot invent impacted recipient membership.
    void event.recipients;
  }

  if (ResendWebhookEventSchema.guards.Delivered(event)) {
    expectTypeOf(event.type).toEqualTypeOf<"email.delivered">();
    // @ts-expect-error -- Returned recipient membership is readonly.
    event.recipients.length = 1;
  }
};

export const proveWebhookCallSites = (
  verifier: IResendWebhookVerifier,
  proof: VerifiedResendWebhook,
): void => {
  expectTypeOf(
    resendWebhookLayer({ signingSecrets: [Redacted.make("fictional-unused-signing-secret")] }),
  ).toEqualTypeOf<Layer.Layer<ResendWebhookVerifier, EmailConfigurationError>>();
  expectTypeOf(verifier.verify({ body: "raw", headers: [] })).toEqualTypeOf<
    Effect.Effect<VerifiedResendWebhook, EmailWebhookVerificationError>
  >();
  // @ts-expect-error -- Webhook signing credentials must remain Redacted.
  void resendWebhookLayer({ signingSecrets: ["unwrapped-secret"] });
  // @ts-expect-error -- Signing authority requires a nonempty rotation list.
  void resendWebhookLayer({ signingSecrets: [] });
  // @ts-expect-error -- Raw header pairs preserve duplicates; merged dictionaries do not.
  void verifier.verify({ body: "raw", headers: { "svix-id": "opaque" } });
  // @ts-expect-error -- Payloads must be unmodified raw UTF-8 strings, never parsed JSON.
  void verifier.verify({ body: { type: "email.delivered" }, headers: [] });

  // @ts-expect-error -- Verification proof cannot be constructed from unverified metadata.
  const forged: VerifiedResendWebhook = {
    body: proof.body,
    id: proof.id,
    timestamp: proof.timestamp,
  };

  void forged;
};

export const proveManagedProviderCallSites = (
  iterable: IIterableCampaignEmail,
  preview: IterableCampaignJob,
): void => {
  const apiKey = Redacted.make("fictional-key");
  expectTypeOf(
    brevoEmailLayer({
      apiKey,
      contentAuthority: "AuthorizeProviderRendering",
      submissionMode: "TransactionalOnly",
      tracking: "AuthorizeProviderTracking",
    }),
  ).toEqualTypeOf<Layer.Layer<Email, EmailConfigurationError, HttpClient.HttpClient>>();
  expectTypeOf(
    sendheronEmailLayer({
      apiKey,
      submissionMode: "TransactionalOnly",
      tracking: "AuthorizeProviderTracking",
    }),
  ).toEqualTypeOf<Layer.Layer<Email, EmailConfigurationError, HttpClient.HttpClient>>();
  expectTypeOf(
    sequenzyEmailLayer({
      apiKey,
      automaticUtm: "AccountDisabled",
      contactWrites: "AuthorizeProviderManagedProfiles",
      contentAuthority: "AuthorizeProviderRenderingAndRetention",
      replyTracking: "AccountDisabled",
      senderIdentity: "ExistingVerifiedProfile",
      submissionMode: "TransactionalOnly",
    }),
  ).toEqualTypeOf<Layer.Layer<Email, EmailConfigurationError, HttpClient.HttpClient>>();
  expectTypeOf(
    iterableCampaignLayer({
      apiKey,
      campaignAuthority: "AuthorizeProviderManagedCampaign",
      contactWrites: "AuthorizeProfileCreation",
      dataRetention: "AuthorizePersistedSendData",
      projectIdentity: "EmailBased",
      region: "US",
      tracking: "AuthorizeCampaignTracking",
    }),
  ).toEqualTypeOf<
    Layer.Layer<IterableCampaignEmail, EmailConfigurationError, HttpClient.HttpClient>
  >();
  expectTypeOf(
    iterable.send({ campaignId: 123, recipientEmail: "recipient@example.test" }),
  ).toEqualTypeOf<Effect.Effect<EmailReceipt, EmailSendError>>();
  // @ts-expect-error -- The native campaign service cannot promise common literal-message authority.
  const common: IEmail = iterable;
  void common;
  void iterable.send({
    campaignId: 123,
    // @ts-expect-error -- Campaign jobs cannot inject a sender override.
    from: "host@example.test",
    recipientEmail: "recipient@example.test",
  });
  // @ts-expect-error -- Campaign identity remains readonly after ownership.
  preview.campaignId = 456;
  // @ts-expect-error -- SendHeron cannot fabricate a disabled tracking control.
  void sendheronEmailLayer({ apiKey, submissionMode: "TransactionalOnly", tracking: "Disabled" });
  // @ts-expect-error -- Brevo requires explicit rendering and tracking authorization.
  void brevoEmailLayer({ apiKey });
};

export const proveLoopsCallSites = (loops: ILoopsTransactionalEmail): void => {
  const configuration = {
    apiKey: Redacted.make("fictional-key"),
    attachments: "Disabled",
    templateAuthority: "ProviderManaged",
  } as const;

  const job = {
    dataVariables: { items: [{ amount: 0, name: "Fictional" }] },
    email: "recipient@fictional.invalid",
    transactionalId: "fictional-template",
  } as const;

  expectTypeOf(loopsTransactionalLayer(configuration)).toEqualTypeOf<
    Layer.Layer<LoopsTransactionalEmail, EmailConfigurationError, HttpClient.HttpClient>
  >();
  expectTypeOf(
    loops.send(job, {
      idempotencyKey: "fictional-key",
      policy: { deadline: Duration.seconds(2), initialDelay: Duration.millis(100), maxAttempts: 1 },
    }),
  ).toEqualTypeOf<Effect.Effect<EmailReceipt, EmailSendError>>();
  expectTypeOf(
    loops.sendAll([{ job, options: { idempotencyKey: "per-job-key" } }], { concurrency: 2 }),
  ).toEqualTypeOf<
    Effect.Effect<readonly Result.Result<EmailReceipt, EmailSendError>[], EmailInvalidOptions>
  >();
  // @ts-expect-error -- Common execution metadata is not a native job option.
  void loops.send(job, { executionMetadata: { tenant: "fictional" } });
  // @ts-expect-error -- Native batches require job envelopes rather than ordinary messages.
  void loops.sendAll([{ message }]);
  // @ts-expect-error -- A single batch key cannot identify multiple native jobs.
  void loops.sendAll([{ job }], { concurrency: 2, idempotencyKey: "shared-key" });
  // @ts-expect-error -- Native batch job fields remain strict.
  void loops.sendAll([{ job: { ...job, from: "sender@fictional.invalid" } }]);
  expectTypeOf(loops.validate(job)).toEqualTypeOf<
    Effect.Effect<LoopsTransactionalJob, EmailInvalidMessage | EmailInvalidOptions | EmailRejected>
  >();

  // @ts-expect-error -- Native template jobs cannot masquerade as ordinary Email Layers.
  const ordinary: Layer.Layer<Email, EmailConfigurationError, HttpClient.HttpClient> =
    loopsTransactionalLayer(configuration);

  void ordinary;
  // @ts-expect-error -- Native template construction requires an explicit authority choice.
  void loopsTransactionalLayer({ apiKey: configuration.apiKey, attachments: "Disabled" });
  // @ts-expect-error -- Native template credentials remain Redacted.
  void loopsTransactionalLayer({ ...configuration, apiKey: "unwrapped-key" });
  // @ts-expect-error -- Template selection is required; literal bodies are not variables.
  void loops.send(message);
  // @ts-expect-error -- Native template jobs cannot silently acquire literal sender authority.
  void loops.send({ ...job, from: "sender@fictional.invalid" });
  // @ts-expect-error -- Loops variables do not accept booleans.
  void loops.send({ ...job, dataVariables: { invalid: true } });
  // @ts-expect-error -- Nested object variables are not array blocks.
  void loops.send({ ...job, dataVariables: { invalid: { value: "x" } } });
};

export const proveNativeCaptureCallSites = <E, R>(
  loops: Layer.Layer<LoopsTransactionalEmail, E, R>,
  iterable: Layer.Layer<IterableCampaignEmail, E, R>,
  view: IEmailNativeCapture,
  payload: EmailNativeCapturePayload,
): void => {
  const options = { capacity: 1, maxBytes: 1000, privateData: "AuthorizePayloadCapture" } as const;
  expectTypeOf(capturedLoopsTransactionalLayer(loops, options)).toEqualTypeOf<
    Layer.Layer<LoopsTransactionalEmail | EmailNativeCapture, E | EmailConfigurationError, R>
  >();
  expectTypeOf(capturedIterableCampaignLayer(iterable, options)).toEqualTypeOf<
    Layer.Layer<IterableCampaignEmail | EmailNativeCapture, E | EmailConfigurationError, R>
  >();
  expectTypeOf(view.snapshot).toEqualTypeOf<Effect.Effect<EmailCaptureSnapshot>>();
  expectTypeOf(view.purgeRecords).toEqualTypeOf<Effect.Effect<number>>();
  // @ts-expect-error -- Native capture requires explicit trusted-host permission and bounds.
  void capturedLoopsTransactionalLayer(loops);
  // @ts-expect-error -- A native campaign is not a Loops transactional capability.
  void capturedLoopsTransactionalLayer(iterable, options);
  // @ts-expect-error -- Capture never resets native keys.
  void view.purgeRecords({ resetKeys: true });
  // @ts-expect-error -- Capture retains readonly store authority.
  view.snapshot = Effect.succeed({
    closed: false,
    records: [],
    retainedBytes: 0,
    truncated: false,
  });
  // @ts-expect-error -- Native delegation data is not a common-message submission payload.
  const common: EmailCapturePayload = payload;
  void common;
};

export const proveNativeObservationCallSites = <E, R>(
  loops: Layer.Layer<LoopsTransactionalEmail, E, R>,
  iterable: Layer.Layer<IterableCampaignEmail, E, R>,
  view: IEmailNativeObservations,
  snapshot: EmailNativeObservationSnapshot,
  observer: EmailNativeObserver,
  starting: EmailNativeOperationStarting,
  startingObserver: EmailNativeStartingObserver,
): void => {
  expectTypeOf(
    observedLoopsTransactionalLayer(loops, {}, observer, startingObserver),
  ).toEqualTypeOf<
    Layer.Layer<LoopsTransactionalEmail | EmailNativeObservations, E | EmailConfigurationError, R>
  >();
  expectTypeOf(
    observedIterableCampaignLayer(iterable, {}, observer, startingObserver),
  ).toEqualTypeOf<
    Layer.Layer<IterableCampaignEmail | EmailNativeObservations, E | EmailConfigurationError, R>
  >();
  expectTypeOf(view.snapshot).toEqualTypeOf<Effect.Effect<EmailNativeObservationSnapshot>>();
  // @ts-expect-error -- Native observations cannot decorate ordinary EmailSender authority.
  void observedLoopsTransactionalLayer(recordingSenderLayer);
  // @ts-expect-error -- Callback code is not a serialized native capacity option.
  void observedIterableCampaignLayer(iterable, { onReceipt: "callback" });

  expectTypeOf(failingEmailObserver).not.toExtend<EmailNativeObserver>();
  expectTypeOf(failingEmailObserver).not.toExtend<EmailNativeStartingObserver>();
  expectTypeOf(requiringEmailObserver).not.toExtend<EmailNativeStartingObserver>();
  expectTypeOf<EmailNativeObserver>().not.toExtend<EmailNativeStartingObserver>();
  expectTypeOf<EmailSubmissionStartingObserver>().not.toExtend<EmailNativeStartingObserver>();
  expectTypeOf<EmailRetryObserver>().not.toExtend<EmailNativeStartingObserver>();
  // @ts-expect-error -- Starting facts cannot change native operation identity.
  starting.operation = "IterableCampaign";
  // @ts-expect-error -- Starting facts expose no native job payload.
  void starting.job;
  // @ts-expect-error -- Native starting callbacks are explicit host code, not capacity options.
  void observedIterableCampaignLayer(iterable, { onStarting: startingObserver });
  // @ts-expect-error -- Whole-operation observers cannot consume sender-invocation facts.
  void observedEmailSenderLayer(recordingSenderLayer, {}, observer);
  // @ts-expect-error -- Native operation facts cannot be mistaken for low-level sender facts.
  const common: IEmailSubmissionObservations = view;
  // @ts-expect-error -- Native snapshots remain detached readonly values.
  snapshot.observations.length = 0;
  // @ts-expect-error -- Native facts retain no recipient or job payload.
  void snapshot.observations[0]?.recipientEmail;
  // @ts-expect-error -- Native observations never reset replay or operation history.
  void view.clear;
  void common;
};

export const proveIterableDefaultsCallSites = <E, R>(
  account: Layer.Layer<IterableCampaignEmail, E, R>,
  defaults: IterableCampaignDefaultsInput,
): void => {
  expectTypeOf(defaultedIterableCampaignLayer(account, defaults)).toEqualTypeOf<
    Layer.Layer<IterableCampaignEmail, E | EmailConfigurationError, R>
  >();
  void defaultedIterableCampaignLayer(account, {
    dataFields: { values: [0, false, null, "Fictional"] },
    metadata: { workflow: "Fictional" },
  });
  // @ts-expect-error -- Native defaults cannot decorate ordinary literal Email.
  void defaultedIterableCampaignLayer(recordingEmailLayer, {});
  // @ts-expect-error -- Campaign selection remains explicit per job.
  void defaultedIterableCampaignLayer(account, { campaignId: 123 });
  // @ts-expect-error -- Iterable has no native key authority to augment.
  void defaultedIterableCampaignLayer(account, { idempotencyKeyPrefix: "host/" });
  // @ts-expect-error -- Native data defaults cannot introduce nested object values.
  void defaultedIterableCampaignLayer(account, { dataFields: { nested: { value: 0 } } });
  // @ts-expect-error -- Native metadata remains string-valued.
  void defaultedIterableCampaignLayer(account, { metadata: { value: false } });
};

export const proveLoopsDefaultsCallSites = <E, R>(
  account: Layer.Layer<LoopsTransactionalEmail, E, R>,
  defaults: LoopsTransactionalDefaultsInput,
): void => {
  expectTypeOf(defaultedLoopsTransactionalLayer(account, defaults)).toEqualTypeOf<
    Layer.Layer<LoopsTransactionalEmail, E | EmailConfigurationError, R>
  >();
  void defaultedLoopsTransactionalLayer(account, {
    dataVariables: { items: [{ amount: 0, title: "Fictional" }] },
    idempotencyKeyPrefix: "host/",
  });
  // @ts-expect-error -- Native defaults cannot decorate ordinary literal Email.
  void defaultedLoopsTransactionalLayer(recordingEmailLayer, {});
  // @ts-expect-error -- Defaults never provide a shared logical key.
  void defaultedLoopsTransactionalLayer(account, { idempotencyKey: "shared" });
  // @ts-expect-error -- Host template selection remains required per job.
  void defaultedLoopsTransactionalLayer(account, { transactionalId: "template" });
  // @ts-expect-error -- Defaults obey native Loops scalar semantics, not arbitrary JSON.
  void defaultedLoopsTransactionalLayer(account, { dataVariables: { flag: true } });
  // @ts-expect-error -- Native nested records require a nonempty array block.
  void defaultedLoopsTransactionalLayer(account, { dataVariables: { nested: { value: 0 } } });
};

export const proveSmtpCallSites = (receipt: EmailReceipt): void => {
  const options = {
    authentication: SmtpAuthenticationSchema.cases.None.make({}),
    helloName: "client.fictional.invalid",
    host: "smtp.fictional.invalid",
    mailFlow: "ProviderUnmodified",
    port: 465,
    security: "ImplicitTls",
  } as const;

  expectTypeOf(smtpEmailLayer(options)).toEqualTypeOf<
    Layer.Layer<Email, EmailConfigurationError>
  >();
  expectTypeOf(smtpSenderLayer(options)).toEqualTypeOf<
    Layer.Layer<EmailSender, EmailConfigurationError>
  >();
  // @ts-expect-error -- TLS cannot be disabled through the public SMTP configuration.
  void smtpEmailLayer({ ...options, security: "Plaintext" });
  // @ts-expect-error -- SMTP submission requires explicit mail-flow authority.
  void smtpEmailLayer({
    authentication: options.authentication,
    helloName: options.helloName,
    host: options.host,
    port: 465,
    security: "ImplicitTls",
  });
  void SmtpAuthenticationSchema.cases.Plain.make({
    // @ts-expect-error -- SMTP passwords remain Redacted, including native authentication constructors.
    password: "unwrapped-secret",
    username: Redacted.make("fictional-user"),
  });

  if (EmailReceiptSchema.guards.PartiallyRejected(receipt)) {
    // @ts-expect-error -- Rejected recipients are an immutable terminal partition.
    receipt.rejected.length = 0;
    // @ts-expect-error -- SMTP does not invent provider correlation handles.
    void receipt.messageId;
  }
};

export const proveSesCallSites = (): void => {
  const configuration = {
    accessKeyId: Redacted.make("AKIAFICTIONALEXAMPLE1"),
    mailFlow: "ProviderUnmodified",
    region: "us-east-1",
    secretAccessKey: Redacted.make("fictional-secret"),
  } as const;

  expectTypeOf(sesEmailLayer(configuration)).toEqualTypeOf<
    Layer.Layer<Email, EmailConfigurationError, HttpClient.HttpClient>
  >();
  expectTypeOf(sesSenderLayer(configuration)).toEqualTypeOf<
    Layer.Layer<EmailSender, EmailConfigurationError, HttpClient.HttpClient>
  >();
  // @ts-expect-error -- Region and remote mail-flow choices remain explicit.
  void sesEmailLayer({
    accessKeyId: configuration.accessKeyId,
    secretAccessKey: configuration.secretAccessKey,
  });
  // @ts-expect-error -- Access identifiers remain Redacted with the other credentials.
  void sesEmailLayer({ ...configuration, accessKeyId: "unwrapped-key" });
  // @ts-expect-error -- Secret access keys remain Redacted.
  void sesEmailLayer({ ...configuration, secretAccessKey: "unwrapped-secret" });
  // @ts-expect-error -- Session tokens remain Redacted.
  void sesEmailLayer({ ...configuration, sessionToken: "unwrapped-token" });
  // @ts-expect-error -- Unreviewed partitions/regions cannot widen the signed protocol.
  void sesEmailLayer({ ...configuration, region: "us-gov-west-1" });
  // @ts-expect-error -- Arbitrary hosts cannot widen the signed protocol.
  void sesEmailLayer({ ...configuration, baseUrl: "https://fictional.test" });
};

export const proveCloudflareCallSites = (): void => {
  const configuration = {
    accountId: "0123456789abcdef0123456789abcdef",
    apiToken: Redacted.make("fictional-token"),
    mailFlow: "ProviderUnmodified",
  } as const;

  expectTypeOf(cloudflareEmailLayer(configuration)).toEqualTypeOf<
    Layer.Layer<Email, EmailConfigurationError, HttpClient.HttpClient>
  >();
  expectTypeOf(cloudflareSenderLayer(configuration)).toEqualTypeOf<
    Layer.Layer<EmailSender, EmailConfigurationError, HttpClient.HttpClient>
  >();
  // @ts-expect-error -- Account and mail-flow choices are explicit.
  void cloudflareEmailLayer({ apiToken: configuration.apiToken });
  // @ts-expect-error -- Credentials remain Redacted at the public seam.
  void cloudflareEmailLayer({ ...configuration, apiToken: "unwrapped-token" });
  // @ts-expect-error -- Arbitrary hosts cannot widen the reviewed REST protocol.
  void cloudflareEmailLayer({ ...configuration, baseUrl: "https://fictional.test" });
};

export const proveGraphCallSites = (): void => {
  const configuration = {
    accessToken: Redacted.make("fictional-access-token"),
    mailFlow: "ProviderUnmodified",
    mailboxAddress: "sender@example.test",
    mailboxId: "33333333-3333-4333-8333-333333333333",
    senderIdentity: "OwnerOrSendAs",
    sentItems: "DoNotSave",
  } as const;

  const layer = graphEmailLayer(configuration);
  expectTypeOf(layer).toEqualTypeOf<
    Layer.Layer<Email, EmailConfigurationError, HttpClient.HttpClient>
  >();
  expectTypeOf(graphSenderLayer(configuration)).toEqualTypeOf<
    Layer.Layer<EmailSender, EmailConfigurationError, HttpClient.HttpClient>
  >();
  // @ts-expect-error -- Mailbox binding, identity and sent-item choices must be explicit.
  void graphEmailLayer({ accessToken: configuration.accessToken });
  // @ts-expect-error -- Access tokens remain Redacted at the public boundary.
  void graphEmailLayer({ ...configuration, accessToken: "unwrapped-token" });
  // @ts-expect-error -- Send-on-behalf identity is not represented by this constrained protocol.
  void graphEmailLayer({ ...configuration, senderIdentity: "SendOnBehalf" });
  // @ts-expect-error -- Arbitrary hosts cannot widen the reviewed Graph protocol.
  void graphEmailLayer({ ...configuration, baseUrl: "https://fictional.test" });
};

export const proveZeptomailCallSites = (): void => {
  const layer = zeptomailEmailLayer({
    agentMode: "Sandbox",
    apiKey: Redacted.make("fictional-key"),
  });

  expectTypeOf(layer).toEqualTypeOf<
    Layer.Layer<Email, EmailConfigurationError, HttpClient.HttpClient>
  >();
  // @ts-expect-error -- Agent mode cannot silently turn simulation into acceptance.
  void zeptomailEmailLayer({ apiKey: Redacted.make("fictional-key") });
  void zeptomailEmailLayer({
    agentMode: "Live",
    // @ts-expect-error -- Send tokens remain Redacted in the public protocol boundary.
    apiKey: "unwrapped-key",
  });
  void zeptomailEmailLayer({
    agentMode: "Live",
    apiKey: Redacted.make("fictional-key"),
    // @ts-expect-error -- Arbitrary hosts cannot widen the reviewed protocol.
    baseUrl: "https://fictional.test",
  });
};

export const proveScalewayCallSites = (): void => {
  const layer = scalewayEmailLayer({
    projectId: "33333333-3333-4333-8333-333333333333",
    secretKey: Redacted.make("fictional-key"),
    tracking: "ProviderDisabled",
  });

  expectTypeOf(layer).toEqualTypeOf<
    Layer.Layer<Email, EmailConfigurationError, HttpClient.HttpClient>
  >();
  // @ts-expect-error -- Scaleway construction cannot silently choose project or tracking state.
  void scalewayEmailLayer({ secretKey: Redacted.make("fictional-key") });
  void scalewayEmailLayer({
    projectId: "33333333-3333-4333-8333-333333333333",
    // @ts-expect-error -- Scaleway credentials remain Redacted.
    secretKey: "unwrapped-key",
    tracking: "ProviderDisabled",
  });
};

export const proveEmailRecipientOutcomeHandling = (receipt: EmailReceipt): void => {
  if (!EmailReceiptSchema.guards.RecipientOutcomes(receipt)) {
    return;
  }

  const [first] = receipt.outcomes;
  expectTypeOf(receipt.messageId).toEqualTypeOf<typeof EmailMessageIdSchema.Type | undefined>();

  if (EmailRecipientOutcomeSchema.guards.Accepted(first)) {
    expectTypeOf(first.messageId).toEqualTypeOf<typeof EmailMessageIdSchema.Type>();
  }

  // @ts-expect-error -- Per-recipient evidence remains immutable in caller declarations.
  receipt.outcomes[0] = first;
  // @ts-expect-error -- A recipient outcome cannot be redirected after acknowledgement.
  first.recipient = EmailAddressSchema.make("other@example.test");
};

export const proveNativeAttachmentCallSites = () => {
  const buffer = emailAttachmentFromArrayBuffer(new ArrayBuffer(1), {
    contentType: "text/plain",
    filename: "example.txt",
  });

  const blob = emailAttachmentFromBlob(new Blob(["synthetic"]), {
    contentType: "ProviderSelected",
    filename: "example.txt",
  });

  expectTypeOf(buffer).toEqualTypeOf<Effect.Effect<EmailAttachment, EmailInvalidMessage>>();
  expectTypeOf(blob).toEqualTypeOf<Effect.Effect<EmailAttachment, EmailInvalidMessage>>();
  // @ts-expect-error -- Shared mutable memory is not an owned ArrayBuffer source.
  void emailAttachmentFromArrayBuffer(new SharedArrayBuffer(1), {
    contentType: "text/plain",
    filename: "example.txt",
  });
  // @ts-expect-error -- Blob MIME cannot replace explicit media-type authority.
  void emailAttachmentFromBlob(new Blob(["synthetic"], { type: "text/plain" }), {
    filename: "example.txt",
  });
};

const requiringOperationObserver = () => Email.pipe(Effect.asVoid);

const failingOperationObserver = () =>
  Effect.fail(new EmailRejected({ provider: "host", reason: "rejected" }));

export const proveCredentialFreePreflightCalls = (): void => {
  const options = {
    executionMetadata: { nested: { private: true } },
    idempotencyKey: "caller-key",
  };

  expectTypeOf(preflightResendEmail(message, options)).toEqualTypeOf<
    Effect.Effect<EmailMessage, EmailInvalidMessage | EmailInvalidOptions | EmailRejected>
  >();

  for (const preflight of [
    preflightSendgridEmail,
    preflightMailgunEmail,
    preflightMailersendEmail,
    preflightMailpaceEmail,
    preflightUnosendEmail,
  ]) {
    expectTypeOf(preflight(message, options)).toEqualTypeOf<
      Effect.Effect<EmailMessage, EmailInvalidMessage | EmailInvalidOptions | EmailRejected>
    >();
  }

  expectTypeOf(preflightPostmarkEmail(message)).toEqualTypeOf<
    Effect.Effect<EmailMessage, EmailInvalidMessage | EmailInvalidOptions | EmailRejected>
  >();
};

export const proveOperationObserverCallSites = (): void => {
  const source = resendEmailLayer({ apiKey: Redacted.make("fictional-unused-key") });

  const layer = observedEmailOperationLayer(source, (event) => {
    expectTypeOf(event.previews[0].options.idempotencyKey).toEqualTypeOf<
      EmailIdempotencyKey | undefined
    >();
    // @ts-expect-error -- Observers cannot replace reviewed intent.
    event.previews[0].message.subject = "changed";

    if (EmailOperationOutcomeSchema.guards.Receipt(event.outcome)) {
      expectTypeOf(event.outcome.route).toEqualTypeOf<EmailRouteName | undefined>();
      // @ts-expect-error -- An observation is not an executable operation.
      void event.send;
    }

    return Effect.void;
  });

  expectTypeOf(layer).toEqualTypeOf<
    Layer.Layer<Email, EmailConfigurationError, HttpClient.HttpClient>
  >();
  expectTypeOf(failingOperationObserver).not.toExtend<EmailOperationObserver>();
  expectTypeOf(requiringOperationObserver).not.toExtend<EmailOperationObserver>();
};

const requiringEmailTransformation = ({ message: input }: EmailMessageTransformInput) =>
  Email.pipe(Effect.as(input));

export const proveObservationAggregateCallSites = <E1, R1, E2, R2>(
  common: Layer.Layer<EmailSubmissionObservations, E1, R1>,
  native: Layer.Layer<EmailNativeObservations, E2, R2>,
  view: IEmailObservationAggregate,
): void => {
  const layer = aggregatedEmailObservationsLayer([
    { kind: "Submission", layer: common, name: "account" },
    { kind: "Native", layer: native, name: "native" },
  ]);

  expectTypeOf(layer).toEqualTypeOf<
    Layer.Layer<EmailObservationAggregate, E1 | E2 | EmailConfigurationError, R1 | R2>
  >();
  expectTypeOf(view.snapshot).toEqualTypeOf<
    Effect.Effect<EmailObservationAggregateSnapshot, EmailObservationAggregateError>
  >();
  void view.snapshot.pipe(
    Effect.map((snapshot) => {
      const [source] = snapshot.sources;

      if (EmailObservationAggregateSourceSchema.guards.NativeOperation(source)) {
        const [fact] = source.snapshot.observations;
        expectTypeOf(fact?.operation).toEqualTypeOf<
          "LoopsTransactional" | "IterableCampaign" | undefined
        >();
      }

      // @ts-expect-error -- Aggregate samples retain immutable source order.
      snapshot.sources[0] = source;
      // @ts-expect-error -- Minimal facts do not expose private intent.
      void source.snapshot.observations[0]?.message;

      return snapshot;
    }),
  );
  // @ts-expect-error -- Sources must be explicitly nonempty.
  void aggregatedEmailObservationsLayer<readonly [EmailObservationBinding<never, never>]>([]);
  void aggregatedEmailObservationsLayer<readonly [EmailObservationBinding<E1, R1>]>([
    // @ts-expect-error -- Common sender facts are not native-operation sources.
    { kind: "Native", layer: common, name: "wrong" },
  ]);
  // @ts-expect-error -- A query capability cannot purge source history.
  void view.purgeObservations;
};

export const proveCaptureAggregateCallSites = <E1, R1, E2, R2>(
  common: Layer.Layer<EmailSubmissionCapture, E1, R1>,
  native: Layer.Layer<EmailNativeCapture, E2, R2>,
  view: IEmailCaptureAggregate,
): void => {
  const layer = aggregatedEmailCaptureLayer([
    { kind: "Submission", layer: common, name: "account" },
    { kind: "Native", layer: native, name: "native" },
  ]);

  expectTypeOf(layer).toEqualTypeOf<
    Layer.Layer<EmailCaptureAggregate, E1 | E2 | EmailConfigurationError, R1 | R2>
  >();
  expectTypeOf(view.snapshot).toEqualTypeOf<
    Effect.Effect<EmailCaptureAggregateSnapshot, EmailCaptureAggregateError>
  >();
  // @ts-expect-error -- Aggregation cannot silently choose an empty collection of accounts.
  void aggregatedEmailCaptureLayer<readonly [EmailCaptureBinding<never, never>]>([]);
  void aggregatedEmailCaptureLayer<readonly [EmailCaptureBinding<E1, R1>]>([
    // @ts-expect-error -- Native payload units require the native capture capability.
    { kind: "Native", layer: common, name: "wrong" },
  ]);
  // @ts-expect-error -- A read-only aggregate does not grant retention mutation.
  void view.purgeRecords;
};

export const proveOwnedEmailAccountCallSites = <E1, R1, E2, R2>(
  capturedFirst: Layer.Layer<Email | EmailSubmissionCapture, E1, R1>,
  capturedSecond: Layer.Layer<Email | EmailSubmissionCapture, E2, R2>,
  observedFirst: Layer.Layer<Email | EmailSubmissionObservations, E1, R1>,
  observedSecond: Layer.Layer<Email | EmailSubmissionObservations, E2, R2>,
): void => {
  expectTypeOf(
    capturedEmailRouterLayer(
      [
        { layer: capturedFirst, name: "first" },
        { layer: capturedSecond, name: "second" },
      ],
      { primary: "first" },
    ),
  ).toEqualTypeOf<
    Layer.Layer<
      Email | EmailRouter | EmailCaptureAggregate,
      E1 | E2 | EmailConfigurationError,
      R1 | R2
    >
  >();
  expectTypeOf(
    observedEmailRouterLayer(
      [
        { layer: observedFirst, name: "first" },
        { layer: observedSecond, name: "second" },
      ],
      { primary: "first" },
    ),
  ).toEqualTypeOf<
    Layer.Layer<
      Email | EmailRouter | EmailObservationAggregate,
      E1 | E2 | EmailConfigurationError,
      R1 | R2
    >
  >();
};

export const proveEmailProviderAuthoringCallSites = <E, R, EO, RO, ER, RR>(
  profile: EmailProviderProfile,
  acquire: Effect.Effect<EmailHttpExchange, E, R>,
  observer: Effect.Effect<EmailRetryObserver, EO, RO | EmailSender | Scope.Scope>,
  restriction: Effect.Effect<EmailRetryRestriction, ER, RR | EmailSender | Scope.Scope>,
): void => {
  const provider = defineEmailHttpProvider({
    configuration: Schema.Struct({
      apiKey: EmailHttpCredentialSchema,
      retryBudget: Schema.FiniteFromString,
    }),
    makeProtocol: (configuration) => {
      expectTypeOf(configuration.apiKey).toEqualTypeOf<Redacted.Redacted>();
      expectTypeOf(configuration.retryBudget).toEqualTypeOf<number>();

      return acquire;
    },
    profile,
    span: "ExternalProvider.submit",
  });

  const options = { apiKey: Redacted.make("explicit-credential"), retryBudget: 2 };

  expectTypeOf(provider.senderLayer(options)).toEqualTypeOf<
    Layer.Layer<
      EmailSender,
      EmailConfigurationError | E,
      HttpClient.HttpClient | Exclude<R, Scope.Scope>
    >
  >();
  expectTypeOf(provider.emailLayer(options, undefined, observer, restriction)).toEqualTypeOf<
    Layer.Layer<
      Email,
      EmailConfigurationError | E | EO | ER,
      | HttpClient.HttpClient
      | Exclude<R, Scope.Scope>
      | Exclude<Exclude<RO | RR, Scope.Scope>, EmailSender>
    >
  >();
  expectTypeOf(provider.preflight(message)).toEqualTypeOf<
    Effect.Effect<EmailMessage, EmailInvalidMessage | EmailInvalidOptions | EmailRejected>
  >();
  // @ts-expect-error -- Provider options accept decoded configuration, not its encoded representation.
  void provider.senderLayer({ apiKey: options.apiKey, retryBudget: "2" });
  // @ts-expect-error -- Credentials are explicit Redacted values even when the codec can encode strings.
  void provider.senderLayer({ apiKey: "credential", retryBudget: 2 });
  // @ts-expect-error -- Required configuration cannot be omitted.
  void provider.emailLayer({ apiKey: options.apiKey });
  // @ts-expect-error -- Author metadata cannot be mutated through the owned public profile.
  provider.profile.capabilities.tags.maxCount = 1;
};

export const proveAcquiredEmailExtensionCallSites = <E, R>(
  source: Layer.Layer<Email>,
  transform: Effect.Effect<EmailMessageTransform, E, R>,
  observer: Effect.Effect<EmailOperationObserver, E, R>,
  retryObserver: Effect.Effect<EmailRetryObserver, E, R>,
  retryRestriction: Effect.Effect<EmailRetryRestriction, E, R>,
  sender: Layer.Layer<EmailSender>,
  submissionObserver: Effect.Effect<EmailSubmissionObserver, E, R>,
  submissionStarting: Effect.Effect<EmailSubmissionStartingObserver, E, R>,
  loops: Layer.Layer<LoopsTransactionalEmail>,
  iterable: Layer.Layer<IterableCampaignEmail>,
  nativeObserver: Effect.Effect<EmailNativeObserver, E, R>,
  nativeStarting: Effect.Effect<EmailNativeStartingObserver, E, R>,
): void => {
  expectTypeOf(transformedEmailLayer(source, transform)).toEqualTypeOf<
    Layer.Layer<Email, EmailConfigurationError | E, Exclude<Exclude<R, Scope.Scope>, Email>>
  >();
  expectTypeOf(observedEmailOperationLayer(source, observer)).toEqualTypeOf<
    Layer.Layer<Email, EmailConfigurationError | E, Exclude<Exclude<R, Scope.Scope>, Email>>
  >();
  expectTypeOf(emailLayer(undefined, retryObserver, retryRestriction)).toEqualTypeOf<
    Layer.Layer<Email, EmailConfigurationError | E, EmailSender | Exclude<R, Scope.Scope>>
  >();
  expectTypeOf(
    observedEmailSenderLayer(sender, {}, submissionObserver, submissionStarting),
  ).toEqualTypeOf<
    Layer.Layer<
      EmailSender | EmailSubmissionObservations,
      EmailConfigurationError | E,
      Exclude<Exclude<R, Scope.Scope>, EmailSender>
    >
  >();
  expectTypeOf(
    observedLoopsTransactionalLayer(loops, {}, nativeObserver, nativeStarting),
  ).toEqualTypeOf<
    Layer.Layer<
      LoopsTransactionalEmail | EmailNativeObservations,
      EmailConfigurationError | E,
      Exclude<Exclude<R, Scope.Scope>, LoopsTransactionalEmail>
    >
  >();
  expectTypeOf(
    observedIterableCampaignLayer(iterable, {}, nativeObserver, nativeStarting),
  ).toEqualTypeOf<
    Layer.Layer<
      IterableCampaignEmail | EmailNativeObservations,
      EmailConfigurationError | E,
      Exclude<Exclude<R, Scope.Scope>, IterableCampaignEmail>
    >
  >();
};

export const proveSuppliedEmailExtensionCallSites = (
  source: Layer.Layer<Email>,
  sender: Layer.Layer<EmailSender>,
  loops: Layer.Layer<LoopsTransactionalEmail>,
  iterable: Layer.Layer<IterableCampaignEmail>,
  transform: EmailMessageTransform,
  observer: EmailOperationObserver,
  submission: EmailSubmissionObserver,
  native: EmailNativeObserver,
): void => {
  const transformed = transformedEmailLayer(source, Email.pipe(Effect.as(transform)));
  expectTypeOf(transformed).toEqualTypeOf<Layer.Layer<Email, EmailConfigurationError>>();
  expectTypeOf(Email.pipe(Effect.provide(transformed))).toEqualTypeOf<
    Effect.Effect<IEmail, EmailConfigurationError>
  >();
  expectTypeOf(observedEmailOperationLayer(source, Email.pipe(Effect.as(observer)))).toEqualTypeOf<
    Layer.Layer<Email, EmailConfigurationError>
  >();
  expectTypeOf(
    observedEmailSenderLayer(sender, {}, EmailSender.pipe(Effect.as(submission))),
  ).toEqualTypeOf<
    Layer.Layer<EmailSender | EmailSubmissionObservations, EmailConfigurationError>
  >();
  expectTypeOf(
    observedLoopsTransactionalLayer(loops, {}, LoopsTransactionalEmail.pipe(Effect.as(native))),
  ).toEqualTypeOf<
    Layer.Layer<LoopsTransactionalEmail | EmailNativeObservations, EmailConfigurationError>
  >();
  expectTypeOf(
    observedIterableCampaignLayer(iterable, {}, IterableCampaignEmail.pipe(Effect.as(native))),
  ).toEqualTypeOf<
    Layer.Layer<IterableCampaignEmail | EmailNativeObservations, EmailConfigurationError>
  >();
};

export const provePreparedEmailCallSites = (email: IEmail, routed: IEmailRoute): void => {
  expectTypeOf(email.prepare(message)).toEqualTypeOf<
    Effect.Effect<EmailPreparedOperation, EmailInvalidMessage | EmailInvalidOptions | EmailRejected>
  >();
  expectTypeOf(routed.prepare(message)).toEqualTypeOf<
    Effect.Effect<
      EmailPreparedOperation<EmailRoutedReceipt>,
      EmailInvalidMessage | EmailInvalidOptions | EmailRejected
    >
  >();

  const transformed = transformedEmailLayer(
    resendEmailLayer({ apiKey: Redacted.make("fictional-unused-key") }),
    ({ message: input, options }) => {
      expectTypeOf(options.executionMetadata).toEqualTypeOf<EmailExecutionMetadata | undefined>();

      const tenant = options.executionMetadata?.tenant;

      return Effect.succeed({
        ...input,
        subject: Predicate.isString(tenant) ? `${input.subject}/${tenant}` : input.subject,
      });
    },
  );

  expectTypeOf(transformed).toEqualTypeOf<
    Layer.Layer<Email, EmailConfigurationError, HttpClient.HttpClient>
  >();
  void email.send(message, {
    executionMetadata: {
      count: 0,
      empty: null,
      enabled: false,
      profile: {
        at: DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-02T03:04:05.123Z")),
        values: [0, false, null, undefined],
      },
      tenant: "fictional",
    },
  });
  // @ts-expect-error -- Execution metadata excludes nonrepresentable bigint values.
  void email.send(message, { executionMetadata: { tenant: 1n } });

  expectTypeOf(requiringEmailTransformation).not.toExtend<EmailMessageTransform>();
  void email.prepare(message).pipe(
    Effect.map((operation) => {
      // @ts-expect-error -- Prepared previews are nonempty immutable operation snapshots.
      operation.previews = [operation.previews[0]];
      const metadata = operation.previews[0].options.executionMetadata;

      if (metadata !== undefined) {
        // @ts-expect-error -- Execution metadata cannot be changed through prepared previews.
        metadata.tenant = "changed";
      }

      expectTypeOf(operation.previews[0].options.idempotencyKey).toEqualTypeOf<
        EmailIdempotencyKey | undefined
      >();
      expectTypeOf(operation.send).not.toExtend<Effect.Effect<EmailReceipt>>();

      return operation;
    }),
  );
};

export const proveEmailCallSites = (
  email: IEmail,
  sender: IEmailSender,
  parsed: EmailMessage,
): void => {
  const send = email.send(message, { idempotencyKey: "notification/event-1" });

  expectTypeOf(send).toEqualTypeOf<Effect.Effect<EmailReceipt, EmailSendError>>();

  void email.send(message, {
    policy: { deadline: Duration.seconds(5), initialDelay: Duration.millis(100), maxAttempts: 1 },
  });

  const personalized = email.sendPersonalized(
    {
      message: {
        body: { text: "%recipient.name%" },
        from: "sender@example.test",
        subject: "Hello %recipient.name%",
      },
      recipients: [
        {
          idempotencyKey: "event/synthetic",
          to: "recipient@example.test",
          variables: { active: false, count: 0, name: "Synthetic" },
        },
      ],
    },
    { executionMetadata: { count: 0, enabled: false, tenant: "fictional-context" } },
  );

  expectTypeOf(personalized).toEqualTypeOf<
    Effect.Effect<
      readonly Result.Result<EmailReceipt, EmailSendError>[],
      EmailInvalidMessage | EmailInvalidOptions
    >
  >();

  const preview = renderEmailPersonalizedMessage(
    { body: { text: "%recipient.name%" }, from: "sender@example.test", subject: "Hello" },
    { to: "recipient@example.test", variables: { name: "Synthetic" } },
  );

  expectTypeOf(preview).toEqualTypeOf<Effect.Effect<EmailMessage, EmailInvalidMessage>>();
  void email.sendPersonalized({
    message: { body: { text: "Synthetic" }, from: "sender@example.test", subject: "Synthetic" },
    // @ts-expect-error -- Personalized audiences must be statically nonempty.
    recipients: [],
  });

  const batch = email.sendAll([{ message, options: { idempotencyKey: "event/first" } }]);

  expectTypeOf(batch).toEqualTypeOf<
    Effect.Effect<readonly Result.Result<EmailReceipt, EmailSendError>[], EmailInvalidOptions>
  >();

  void email.sendPersonalized(
    {
      message: { body: { text: "Synthetic" }, from: "sender@example.test", subject: "Synthetic" },
      recipients: [{ to: "recipient@example.test", variables: {} }],
    },
    {
      executionMetadata: { tenant: "fictional-context" },
      // @ts-expect-error -- Shared audience context cannot supply one replay identity for many recipients.
      idempotencyKey: "shared-key",
    },
  );

  // @ts-expect-error -- Each batch request must contain its message envelope.
  void email.sendAll([{}]);
  // @ts-expect-error -- Unsupported batch wrapper fields must not enter the declared contract.
  void email.sendAll([{ message, scheduledAt: "tomorrow" }]);
  // @ts-expect-error -- A recipient list must be statically nonempty.
  void email.send({ ...message, to: [] });
  // @ts-expect-error -- Neither body alternative may be absent.
  void email.send({ ...message, body: {} });
  // @ts-expect-error -- Scheduling uses the schema-owned sendAt field, not scheduledAt.
  void email.send({ ...message, scheduledAt: "tomorrow" });
  // @ts-expect-error -- Each batch item owns its key; a batch-wide key is invalid.
  void email.sendAll([{ message }], { concurrency: 2, idempotencyKey: "one-key" });

  void emailAttachmentFromBytes(new Uint8Array([0, 255, 128]), {
    contentType: "ProviderSelected",
    filename: "sample.png",
  });

  const attachment = emailAttachmentFromBytes(new Uint8Array([0, 255, 128]), {
    contentType: "application/octet-stream",
    filename: "sample.bin",
  });

  expectTypeOf(attachment).toEqualTypeOf<Effect.Effect<EmailAttachment, EmailInvalidMessage>>();
  void email.send({
    ...message,
    attachments: [
      { contentBase64: "AP+A", contentType: "application/octet-stream", filename: "sample.bin" },
    ],
  });
  // @ts-expect-error -- Omit attachments instead of supplying an empty attachment list.
  void email.send({ ...message, attachments: [] });
  void email.send({
    ...message,
    attachments: [
      {
        // @ts-expect-error -- Raw bytes must pass through the owned Base64 constructor.
        contentBase64: new Uint8Array([0]),
        contentType: "application/octet-stream",
        filename: "sample.bin",
      },
    ],
  });
  // @ts-expect-error -- MIME authority must be explicit or consciously delegated to the provider.
  void email.send({ ...message, attachments: [{ contentBase64: "AA==", filename: "sample.bin" }] });
  void email.send({
    ...message,
    attachments: [
      {
        contentBase64: "AA==",
        contentId: "inline",
        contentType: "application/octet-stream",
        disposition: "inline",
        filename: "sample.bin",
      },
    ],
  });

  void email.send({
    ...message,
    cc: "copy@example.test",
    from: { address: "sender@example.test", name: "Synthetic Sender" },
    headers: [{ name: "X-Workflow", value: "example" }],
    metadata: { workflow: "example" },
    sendAt: "2026-10-13T12:00:00Z",
    tags: [{ name: "workflow", value: "example" }],
    to: { address: "recipient@example.test", name: "Synthetic Recipient" },
  });
  const preflight = email.validate(message);
  expectTypeOf(preflight).toEqualTypeOf<
    Effect.Effect<EmailMessage, EmailInvalidMessage | EmailInvalidOptions | EmailRejected>
  >();

  const address = EmailAddressSchema.make("sender@example.test");
  const key = EmailIdempotencyKeySchema.make("event-1");

  void sender.submit({ idempotencyKey: key, message: parsed });
  // @ts-expect-error -- Mailbox addresses cannot stand in for parsed idempotency keys.
  void sender.submit({ idempotencyKey: address, message: parsed });

  const id = EmailMessageIdSchema.make("provider-message-1");

  expectTypeOf(id).not.toEqualTypeOf<typeof address>();
};

export const proveRoutingCallSites = (route: IEmailRoute): void => {
  expectTypeOf(route.send(message)).toEqualTypeOf<
    Effect.Effect<EmailRoutedReceipt, EmailSendError>
  >();
  expectTypeOf(route.sendAll([{ message }])).toEqualTypeOf<
    Effect.Effect<readonly Result.Result<EmailRoutedReceipt, EmailSendError>[], EmailInvalidOptions>
  >();

  const program = Effect.gen(function* useRequiredRouter() {
    const selected = yield* (yield* EmailRouter).select({ primary: "primary" });

    return yield* selected.send(message);
  });

  const routed = program.pipe(
    Effect.provide(
      emailRouterLayer(
        [
          {
            layer: resendEmailLayer({ apiKey: Redacted.make("fictional-token") }),
            name: "primary",
          },
          { layer: recordingEmailLayer, name: "secondary" },
        ],
        { primary: "primary" },
      ),
    ),
  );

  expectTypeOf(routed).toEqualTypeOf<
    Effect.Effect<
      EmailRoutedReceipt,
      EmailSendError | EmailConfigurationError,
      HttpClient.HttpClient
    >
  >();
  // @ts-expect-error -- Routers require a statically nonempty set of bound Email Layers.
  void emailRouterLayer<never, never>([], { primary: "primary" });
};

export const proveNativeSubmissionCorrelation = (receipt: EmailReceipt): void => {
  if (EmailReceiptSchema.guards.Accepted(receipt) && receipt.submissionId !== undefined) {
    void Schema.encodeEffect(EmailSubmissionIdSchema)(receipt.submissionId);
    // @ts-expect-error -- Request-scoped correlation is not a provider message identity.
    void Schema.encodeEffect(EmailMessageIdSchema)(receipt.submissionId);
    // @ts-expect-error -- Caller-visible acknowledgement correlation is readonly.
    receipt.submissionId = EmailSubmissionIdSchema.make("another-submission");
  }
};

export const proveLayerRequirements = (): void => {
  const program = Effect.gen(function* sendWithRequiredService() {
    return yield* (yield* Email).send(message);
  });

  expectTypeOf(program).toEqualTypeOf<Effect.Effect<EmailReceipt, EmailSendError, Email>>();

  const sendgrid = program.pipe(
    Effect.provide(
      sendgridEmailLayer({ apiKey: Redacted.make("fictional-token"), region: "Europe" }),
    ),
  );

  expectTypeOf(sendgrid).toEqualTypeOf<
    Effect.Effect<EmailReceipt, EmailSendError | EmailConfigurationError, HttpClient.HttpClient>
  >();

  const nativePersonalized = Effect.gen(function* submitNativePersonalizedCallSite() {
    return yield* (yield* Email).sendPersonalized({
      message: {
        body: { html: "<p>%recipient.name%</p>" },
        from: "host@example.test",
        subject: "Hello %recipient.name%",
      },
      recipients: [{ to: "recipient@example.test", variables: { name: "Fictional" } }],
    });
  }).pipe(
    Effect.provide(
      sendgridPersonalizedEmailLayer({
        apiKey: Redacted.make("fictional-token"),
        region: "Europe",
      }),
    ),
  );

  expectTypeOf(nativePersonalized).toEqualTypeOf<
    Effect.Effect<
      readonly Result.Result<EmailReceipt, EmailSendError>[],
      EmailInvalidMessage | EmailInvalidOptions | EmailConfigurationError,
      HttpClient.HttpClient
    >
  >();

  const mailgun = program.pipe(
    Effect.provide(
      mailgunEmailLayer({
        apiKey: Redacted.make("fictional-token"),
        domain: "mg.example.test",
        region: "Europe",
      }),
    ),
  );

  const nativeMailgun = Effect.gen(function* submitNativeMailgunCallSite() {
    return yield* (yield* Email).sendPersonalized({
      message: {
        body: { html: "<p>%recipient.name%</p>" },
        from: "host@example.test",
        subject: "Hello %recipient.name%",
      },
      recipients: [{ to: "recipient@example.test", variables: { name: "Fictional" } }],
    });
  }).pipe(
    Effect.provide(
      mailgunPersonalizedEmailLayer({
        apiKey: Redacted.make("fictional-token"),
        domain: "mg.example.test",
        region: "Europe",
      }),
    ),
  );

  expectTypeOf(nativeMailgun).toEqualTypeOf<
    Effect.Effect<
      readonly Result.Result<EmailReceipt, EmailSendError>[],
      EmailInvalidMessage | EmailInvalidOptions | EmailConfigurationError,
      HttpClient.HttpClient
    >
  >();

  const mailersend = program.pipe(
    Effect.provide(mailersendEmailLayer({ apiKey: Redacted.make("fictional-token") })),
  );

  expectTypeOf(mailgun).toEqualTypeOf<
    Effect.Effect<EmailReceipt, EmailSendError | EmailConfigurationError, HttpClient.HttpClient>
  >();
  expectTypeOf(mailersend).toEqualTypeOf<
    Effect.Effect<EmailReceipt, EmailSendError | EmailConfigurationError, HttpClient.HttpClient>
  >();
  // @ts-expect-error -- Mailgun requires an explicit sending domain.
  void mailgunEmailLayer({ apiKey: Redacted.make("fictional-token") });
  // @ts-expect-error -- MailerSend credentials must remain Redacted.
  void mailersendEmailLayer({ apiKey: "unwrapped-credential" });

  const mailpace = program.pipe(
    Effect.provide(mailpaceEmailLayer({ serverToken: Redacted.make("fictional-token") })),
  );

  expectTypeOf(mailpace).toEqualTypeOf<
    Effect.Effect<EmailReceipt, EmailSendError | EmailConfigurationError, HttpClient.HttpClient>
  >();
  // @ts-expect-error -- MailPace domain tokens require Redacted ownership.
  void mailpaceEmailLayer({ serverToken: "unwrapped-token" });

  const unosend = program.pipe(
    Effect.provide(unosendEmailLayer({ apiKey: Redacted.make("fictional-token") })),
  );

  expectTypeOf(unosend).toEqualTypeOf<
    Effect.Effect<EmailReceipt, EmailSendError | EmailConfigurationError, HttpClient.HttpClient>
  >();
  // @ts-expect-error -- Unosend credentials require Redacted ownership.
  void unosendEmailLayer({ apiKey: "unwrapped-token" });

  const lettermint = program.pipe(
    Effect.provide(lettermintEmailLayer({ apiToken: Redacted.make("fictional-token") })),
  );

  expectTypeOf(lettermint).toEqualTypeOf<
    Effect.Effect<EmailReceipt, EmailSendError | EmailConfigurationError, HttpClient.HttpClient>
  >();
  // @ts-expect-error -- Lettermint project credentials require Redacted ownership.
  void lettermintEmailLayer({ apiToken: "unwrapped-token" });

  const jetemail = program.pipe(
    Effect.provide(
      jetemailEmailLayer({
        apiKey: Redacted.make("transactional_fictional-key"),
        automaticBcc: "DomainDisabled",
        deliveryRegion: "Europe",
        tracking: "DomainDisabled",
      }),
    ),
  );

  expectTypeOf(jetemail).toEqualTypeOf<
    Effect.Effect<EmailReceipt, EmailSendError | EmailConfigurationError, HttpClient.HttpClient>
  >();
  // @ts-expect-error -- Domain tracking and hidden recipient settings require explicit attestation.
  void jetemailEmailLayer({ apiKey: Redacted.make("transactional_fictional-key") });
  void jetemailEmailLayer({
    // @ts-expect-error -- Transactional keys must remain Redacted.
    apiKey: "transactional_unwrapped-key",
    automaticBcc: "DomainDisabled",
    tracking: "DomainDisabled",
  });

  const statistics: MailchimpTagStatisticsInput = {
    authority: "AuthorizeKnownAccountTagStatistics",
    knownTags: [{ name: "workflow", value: "fictional" }],
  };

  expectTypeOf({
    authority: "NotAuthorized",
    knownTags: [{ name: "workflow", value: "fictional" }],
  } as const).not.toExtend<MailchimpTagStatisticsInput>();
  expectTypeOf({
    authority: "AuthorizeKnownAccountTagStatistics",
    knownTags: [],
  } as const).not.toExtend<MailchimpTagStatisticsInput>();

  const mailchimp = program.pipe(
    Effect.provide(
      mailchimpEmailLayer({
        apiKey: Redacted.make("fictional-key"),
        automaticFooter: "AccountDisabled",
        keyMode: "Live",
        messageRules: "AccountDisabled",
        tagStatistics: statistics,
      }),
    ),
  );

  expectTypeOf(mailchimp).toEqualTypeOf<
    Effect.Effect<EmailReceipt, EmailSendError | EmailConfigurationError, HttpClient.HttpClient>
  >();
  // @ts-expect-error -- Mailchimp requires live-key and remote-default/rule attestations.
  void mailchimpEmailLayer({ apiKey: Redacted.make("fictional-key") });
  void mailchimpEmailLayer({
    // @ts-expect-error -- Mailchimp authentication must remain Redacted.
    apiKey: "unwrapped-key",
    automaticFooter: "AccountDisabled",
    keyMode: "Live",
    messageRules: "AccountDisabled",
  });

  const mailtrap = program.pipe(
    Effect.provide(
      mailtrapEmailLayer({
        apiKey: Redacted.make("fictional-key"),
        automaticBcc: "DomainDisabled",
        automaticFooter: "DomainDisabled",
        tracking: "DomainDisabled",
      }),
    ),
  );

  expectTypeOf(mailtrap).toEqualTypeOf<
    Effect.Effect<EmailReceipt, EmailSendError | EmailConfigurationError, HttpClient.HttpClient>
  >();
  // @ts-expect-error -- Mailtrap cannot silently attest domain tracking and automatic BCC.
  void mailtrapEmailLayer({ apiKey: Redacted.make("fictional-key") });
  void mailtrapEmailLayer({
    // @ts-expect-error -- Mailtrap credentials remain Redacted.
    apiKey: "unwrapped-key",
    automaticBcc: "DomainDisabled",
    automaticFooter: "DomainDisabled",
    tracking: "DomainDisabled",
  });

  const primitive = program.pipe(
    Effect.provide(
      primitiveEmailLayer({
        apiKey: Redacted.make("prim_fictional-key"),
        keylessSends: "Reject",
        tracking: "ProviderDisabled",
      }),
    ),
  );

  expectTypeOf(primitive).toEqualTypeOf<
    Effect.Effect<EmailReceipt, EmailSendError | EmailConfigurationError, HttpClient.HttpClient>
  >();
  // @ts-expect-error -- Primitive construction explicitly selects keyless behavior and attests disabled provider tracking.
  void primitiveEmailLayer({ apiKey: Redacted.make("prim_fictional-key") });
  void primitiveEmailLayer({
    // @ts-expect-error -- Primitive credentials remain Redacted.
    apiKey: "unwrapped-key",
    keylessSends: "Reject",
    tracking: "ProviderDisabled",
  });

  const sparkpost = program.pipe(
    Effect.provide(
      sparkpostEmailLayer({ apiKey: Redacted.make("fictional-key"), region: "Europe" }),
    ),
  );

  expectTypeOf(sparkpost).toEqualTypeOf<
    Effect.Effect<EmailReceipt, EmailSendError | EmailConfigurationError, HttpClient.HttpClient>
  >();
  // @ts-expect-error -- SparkPost credentials require Redacted ownership.
  void sparkpostEmailLayer({ apiKey: "unwrapped-key" });
  // @ts-expect-error -- SparkPost regions cannot select arbitrary endpoints.
  void sparkpostEmailLayer({ apiKey: Redacted.make("fictional-key"), region: "Unreviewed" });

  const lettr = program.pipe(
    Effect.provide(
      lettrEmailLayer({ apiKey: Redacted.make("lttr_fictional-key"), submissionMode: "Immediate" }),
    ),
  );

  expectTypeOf(lettr).toEqualTypeOf<
    Effect.Effect<EmailReceipt, EmailSendError | EmailConfigurationError, HttpClient.HttpClient>
  >();
  // @ts-expect-error -- Lettr's endpoint must declare its replay authority.
  void lettrEmailLayer({ apiKey: Redacted.make("lttr_fictional-key") });
  void lettrEmailLayer({
    // @ts-expect-error -- Lettr credentials must remain Redacted.
    apiKey: "lttr_unwrapped-key",
    submissionMode: "Scheduled",
  });

  const helo = program.pipe(
    Effect.provide(
      heloEmailLayer({ apiKey: Redacted.make("fictional-token"), channelMode: "Live" }),
    ),
  );

  expectTypeOf(helo).toEqualTypeOf<
    Effect.Effect<EmailReceipt, EmailSendError | EmailConfigurationError, HttpClient.HttpClient>
  >();
  // @ts-expect-error -- Channel mode is not inferred from credentials or remote configuration.
  void heloEmailLayer({ apiKey: Redacted.make("fictional-token") });
  void heloEmailLayer({
    // @ts-expect-error -- Helo credentials require Redacted ownership.
    apiKey: "unwrapped-token",
    channelMode: "Sandbox",
  });

  const plunk = program.pipe(
    Effect.provide(
      plunkEmailLayer({
        apiKey: Redacted.make("sk_fictional-key"),
        contactWrites: "AllowUpsert",
        tracking: "ProjectDisabled",
      }),
    ),
  );

  expectTypeOf(plunk).toEqualTypeOf<
    Effect.Effect<EmailReceipt, EmailSendError | EmailConfigurationError, HttpClient.HttpClient>
  >();
  // @ts-expect-error -- Plunk needs explicit project tracking and contact-write authorization.
  void plunkEmailLayer({ apiKey: Redacted.make("sk_fictional-key") });
  void plunkEmailLayer({
    apiKey: Redacted.make("sk_fictional-key"),
    contactWrites: "AllowUpsert",
    // @ts-expect-error -- Plunk cannot silently permit project tracking.
    tracking: "Enabled",
  });
  void plunkEmailLayer({
    // @ts-expect-error -- Plunk secret credentials require Redacted ownership.
    apiKey: "sk_unwrapped-key",
    contactWrites: "AllowUpsert",
    tracking: "ProjectDisabled",
  });

  const failed = program.pipe(
    Effect.provide(
      failingEmailLayer(new EmailRejected({ provider: "synthetic", reason: "rejected" })),
    ),
  );

  expectTypeOf(failed).toEqualTypeOf<
    Effect.Effect<EmailReceipt, EmailSendError | EmailConfigurationError>
  >();
  // @ts-expect-error -- Synthetic failure scenarios require modeled evidence, not arbitrary Errors.
  void failingEmailLayer(new Error("not-a-modeled-failure"));
  const recorded = program.pipe(Effect.provide(recordingEmailLayer));

  expectTypeOf(recorded).toEqualTypeOf<
    Effect.Effect<EmailReceipt, EmailSendError | EmailConfigurationError>
  >();

  const remote = program.pipe(
    Effect.provide(resendEmailLayer({ apiKey: Redacted.make("fictional-token") })),
  );

  expectTypeOf(remote).toEqualTypeOf<
    Effect.Effect<EmailReceipt, EmailSendError | EmailConfigurationError, HttpClient.HttpClient>
  >();

  const postmark = program.pipe(
    Effect.provide(
      postmarkEmailLayer({
        messageStream: "notifications",
        serverToken: Redacted.make("fictional-token"),
      }),
    ),
  );

  expectTypeOf(postmark).toEqualTypeOf<
    Effect.Effect<EmailReceipt, EmailSendError | EmailConfigurationError, HttpClient.HttpClient>
  >();

  // @ts-expect-error -- Provider credentials must be explicitly redacted.
  void resendEmailLayer({ apiKey: "unwrapped-credential" });
  // @ts-expect-error -- Postmark server credentials must be explicitly redacted.
  void postmarkEmailLayer({ serverToken: "unwrapped-credential" });
  // @ts-expect-error -- Tracking is deliberately outside the Postmark submission options.
  void postmarkEmailLayer({ serverToken: Redacted.make("fictional-token"), trackOpens: true });
};

export const proveEmailAiCallSites = (
  run: EmailAiRunner,
  tool: EmailAiTool,
  receipt: EmailAiReceipt,
): void => {
  expectTypeOf(emailAiTool(run)).toEqualTypeOf<
    Effect.Effect<EmailAiTool, never, EmailAgent | Scope.Scope>
  >();
  expectTypeOf<InferToolInput<EmailAiTool>>().toEqualTypeOf<EmailAgentInput>();
  expectTypeOf<InferToolOutput<EmailAiTool>>().toEqualTypeOf<EmailAiReceipt>();
  const tools = { sendEmail: tool } satisfies ToolSet;
  const options = { context: undefined, messages: [], toolCallId: "untrusted-tool-call-id" };
  void tools.sendEmail.execute(
    { body: { text: "Fictional" }, subject: "Example", to: "recipient@fictional.invalid" },
    options,
  );
  void tool.execute(
    {
      body: { text: "Fictional" },
      // @ts-expect-error -- Model input cannot configure the host sender.
      from: "model@fictional.invalid",
      subject: "Example",
      to: "recipient@fictional.invalid",
    },
    options,
  );
  // @ts-expect-error -- Model-visible results contain no private provider handle.
  void receipt.messageId;
};

export const portableSchedulingContracts = (): void => {
  const date = DateTime.toDateUtc(DateTime.makeUnsafe("2030-01-02T03:04:05Z"));
  const submitted = Email.use((email) => email.send({ ...message, sendAt: date }));
  expectTypeOf(submitted).toEqualTypeOf<Effect.Effect<EmailReceipt, EmailSendError, Email>>();

  const prepared = Email.use((email) =>
    email.validate({ ...message, sendAt: "2030-01-02T08:34:05+05:30" }),
  );

  expectTypeOf(prepared).toEqualTypeOf<
    Effect.Effect<EmailMessage, EmailInvalidMessage | EmailInvalidOptions | EmailRejected, Email>
  >();
  // @ts-expect-error -- Scheduling requires a timestamp, Date or native UTC instant, not raw milliseconds.
  void Email.use((email) => email.send({ ...message, sendAt: 0 }));
};

export const reactEmailComponentContracts = (theme: ReactEmailTheme): void => {
  const components = themedReactEmailComponents(theme);
  void themedReactEmailComponents();
  void themedReactEmailComponents("dark");
  void themedReactEmailComponents(reactEmailTheme("light", { accent: "#1746a2", radius: 0 }));
  expectTypeOf(reactEmailTheme()).toEqualTypeOf<ReactEmailTheme>();
  void renderReactEmail(
    createElement(
      components.EmailDocument,
      { lang: "en" },
      createElement(components.EmailHeading, { level: 3 }, "Fictional heading"),
      createElement(
        components.EmailAction,
        { href: "https://example.invalid", variant: "outline" },
        "Review",
      ),
    ),
  );
  // @ts-expect-error -- Action links require an explicit destination.
  void createElement(components.EmailAction, { children: "Missing destination" });
  // @ts-expect-error -- Heading levels are semantic h1, h2 or h3.
  void createElement(components.EmailHeading, { level: 4 });
  // @ts-expect-error -- Preset names form a closed host-selected vocabulary.
  void themedReactEmailComponents("system");
  // @ts-expect-error -- Theme overrides keep pixel radii numeric.
  void reactEmailTheme("dark", { radius: "12px" });
  // @ts-expect-error -- Theme roles are readonly host configuration.
  theme.background = "changed";
  // @ts-expect-error -- A themed component family is readonly.
  components.EmailAction = () => createElement("p");
};

export const reactEmailContracts = (body: RenderedReactEmail): void => {
  const rendered = renderReactEmail(createElement("p", null, "Fictional content"));
  expectTypeOf(rendered).toEqualTypeOf<Effect.Effect<RenderedReactEmail, EmailRenderError>>();

  const renderedMessage: EmailMessageInput = {
    body,
    from: "sender@example.invalid",
    subject: "Synthetic React content",
    to: "recipient@example.invalid",
  };

  // @ts-expect-error -- React output is an owned readonly value.
  body.html = "changed";
  // @ts-expect-error -- A serialized string is not a host React element.
  void renderReactEmail("private model input");
  // @ts-expect-error -- Rendering always produces both alternatives.
  const incomplete: RenderedReactEmail = { html: "Fictional content" };
  void renderedMessage;
  void incomplete;
};
