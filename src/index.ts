export {
  Email,
  EmailBatchOptionsSchema,
  EmailDeliveryPolicySchema,
  EmailExecutionMetadataSchema,
  EmailPersonalizedOptionsSchema,
  EmailSendOptionsSchema,
  EmailSendRequestSchema,
  emailLayer,
  emailLayerFromSender,
} from "./email-service.js";

export type {
  IEmail,
  EmailDeliveryPolicy,
  EmailBatchOptionsInput,
  EmailExecutionMetadata,
  EmailExecutionMetadataInput,
  EmailExecutionMetadataValue,
  EmailExecutionMetadataInputValue,
  EmailPersonalizedOptionsInput,
  EmailSendOptions,
  EmailSendOptionsInput,
  EmailSendRequest,
} from "./email-service.js";

export { capturedEmailRouterLayer, observedEmailRouterLayer } from "./email-account-routing.js";

export type {
  EmailCapturedRouteBinding,
  EmailObservedRouteBinding,
} from "./email-account-routing.js";

export { EmailSenderPacingOptionsSchema, pacedEmailSenderLayer } from "./email-sender-pacing.js";

export type { EmailSenderPacingOptionsInput } from "./email-sender-pacing.js";

export type { EmailExtension } from "./email-extension.js";

export { sendEmailStream } from "./email-stream.js";

export type { EmailStreamOutcome } from "./email-stream.js";

export { EmailPersonalizationModeSchema } from "./email-composition.js";

export type { EmailPersonalizationMode } from "./email-composition.js";

export type { EmailPreparedOperation, EmailPreparedPreview } from "./email-prepared-operation.js";

export { transformedEmailLayer } from "./email-transformation.js";

export type { EmailMessageTransform, EmailMessageTransformInput } from "./email-transformation.js";

export {
  observedEmailOperationLayer,
  EmailOperationOutcomeSchema,
  EmailOperationObservationError,
} from "./email-operation-observations.js";

export type {
  EmailOperationObserver,
  EmailOperationEvent,
  EmailOperationOutcome,
} from "./email-operation-observations.js";

export { EmailRetryDecisionSchema, EmailRetryCandidateSchema } from "./email-retry-decision.js";

export type {
  EmailRetryDecision,
  EmailRetryCandidate,
  EmailRetryObserver,
  EmailRetryRestriction,
} from "./email-retry-decision.js";

export {
  EmailBodySchema,
  EmailIdempotencyKeySchema,
  EmailMessageSchema,
  EmailMessageIdSchema,
  EmailMessageIdsSchema,
  EmailRecipientOutcomeSchema,
  EmailReceiptSchema,
  EmailSubmissionIdSchema,
  parseEmailMessage,
} from "./email-message.js";

export type {
  EmailBody,
  EmailIdempotencyKey,
  EmailMessage,
  EmailMessageId,
  EmailReceipt,
  EmailRecipientOutcome,
  EmailMessageInput,
  EmailSubmissionId,
} from "./email-message.js";

export { EmailAddressSchema, EmailMailboxSchema, formatEmailMailbox } from "./email-address.js";

export type { EmailAddress, EmailMailbox, EmailMailboxInput } from "./email-address.js";

export {
  EmailHeaderSchema,
  EmailMetadataSchema,
  EmailSendAtSchema,
  EmailTagSchema,
} from "./email-message-metadata.js";

export type { EmailHeader, EmailMetadata, EmailTag } from "./email-message-metadata.js";

export { EmailSenderCapabilitiesSchema } from "./email-capabilities.js";

export type { EmailSenderCapabilities } from "./email-capabilities.js";

export {
  EmailAttachmentSchema,
  emailAttachmentFromBytes,
  emailAttachmentFromArrayBuffer,
  emailAttachmentFromBlob,
} from "./email-attachment.js";

export type {
  EmailAttachment,
  EmailAttachmentInput,
  EmailAttachmentOptions,
} from "./email-attachment.js";

export {
  EmailPersonalizedInputSchema,
  EmailPersonalizedRecipientSchema,
  EmailTemplateSchema,
  renderEmailPersonalizedMessage,
} from "./email-personalization.js";

export type {
  EmailPersonalizedInput,
  EmailPersonalizedRecipientInput,
  EmailTemplateInput,
} from "./email-personalization.js";

export {
  EmailRouter,
  EmailRouteNameSchema,
  EmailRoutePlanSchema,
  EmailRoutedReceiptSchema,
  emailRouterLayer,
} from "./email-routing.js";

export type {
  IEmailRouter,
  IEmailRoute,
  EmailRouteBinding,
  EmailRouteName,
  EmailRoutePlanInput,
  EmailRoutedReceipt,
} from "./email-routing.js";

export {
  EmailRouteCompatibilitySchema,
  EmailRoutePlanExplanationSchema,
  explainEmailRoutePlan,
} from "./email-routing-diagnostics.js";

export type {
  EmailRouteCompatibility,
  EmailRoutePlanExplanation,
} from "./email-routing-diagnostics.js";

export { EmailConfigurationError } from "./email-configuration-error.js";

export { EmailDeliveryUnknown } from "./email-delivery-unknown.js";

export { EmailInvalidMessage } from "./email-invalid-message.js";

export { EmailInvalidOptions } from "./email-invalid-options.js";

export { EmailRejected } from "./email-rejected.js";

export { EmailInputIssueSchema } from "./email-input-issues.js";

export type { EmailInputIssue } from "./email-input-issues.js";

export { EmailSubmissionErrorSchema } from "./email-errors.js";

export type { EmailSendError, EmailSubmissionError } from "./email-errors.js";

export { EmailRecipientCountsSchema } from "./email-recipient-outcomes.js";

export type { EmailRecipientCounts } from "./email-recipient-outcomes.js";

export { EmailSender, EmailSenderIdempotencySchema } from "./email-sender.js";

export type { IEmailSender, EmailSubmission, EmailSenderIdempotency } from "./email-sender.js";
