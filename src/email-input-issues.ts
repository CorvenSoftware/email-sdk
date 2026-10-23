import { Match, Predicate, Schema, SchemaIssue } from "effect";

export const EmailInputIssueSchema = Schema.Struct({ path: Schema.String, problem: Schema.String });

export type EmailInputIssue = typeof EmailInputIssueSchema.Type;

const validationFields = [
  "from",
  "to",
  "cc",
  "bcc",
  "replyTo",
  "subject",
  "body",
  "attachments",
  "filename",
  "contentType",
  "contentBase64",
  "contentId",
  "disposition",
  "address",
  "name",
  "headers",
  "value",
  "tags",
  "metadata",
  "sendAt",
  "capabilities",
  "recipients",
  "variables",
  "dataVariables",
  "email",
  "transactionalId",
  "campaignId",
  "campaignAuthority",
  "contentAuthority",
  "dataFields",
  "dataRetention",
  "projectIdentity",
  "recipientEmail",
  "replyTracking",
  "automaticUtm",
  "templateAuthority",
  "inlineAttachments",
  "attachmentContentTypes",
  "scheduling",
  "maxCount",
  "asciiOnly",
  "message",
  "job",
  "options",
  "text",
  "html",
  "idempotencyKey",
  "idempotencyKeyPrefix",
  "executionMetadata",
  "concurrency",
  "minimumSpacing",
  "capacity",
  "kind",
  "sources",
  "maxBytes",
  "privateData",
  "host",
  "port",
  "security",
  "serverName",
  "helloName",
  "authentication",
  "username",
  "password",
  "certificateAuthority",
  "attemptTimeout",
  "policy",
  "maxAttempts",
  "initialDelay",
  "deadline",
  "automaticBcc",
  "automaticFooter",
  "deliveryRegion",
  "channelId",
  "channelMode",
  "agentMode",
  "accessToken",
  "accessKeyId",
  "secretAccessKey",
  "sessionToken",
  "mailboxId",
  "mailboxAddress",
  "senderIdentity",
  "mailFlow",
  "sentItems",
  "contactWrites",
  "tracking",
  "apiKey",
  "apiToken",
  "accountId",
  "route",
  "serverToken",
  "secretKey",
  "projectId",
  "messageStream",
  "idempotency",
  "retention",
  "signatureField",
  "signingSecrets",
  "tolerance",
  "maxKeyLength",
  "keyFormat",
  "keyRequirement",
  "keylessSends",
  "keyMode",
  "messageRules",
  "submissionMode",
  "primary",
  "fallbacks",
  "region",
  "domain",
] as const;

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1({
  checkHook: (cause) => {
    const expected = cause.filter.annotations?.expected;

    return Predicate.isString(expected) ? `Expected ${expected}` : "Invalid value";
  },
  leafHook: (cause) =>
    Match.value(cause).pipe(
      Match.tag("MissingKey", () => "Required field is missing"),
      Match.tag("UnexpectedKey", () => "Unsupported field"),
      Match.orElse(() => "Invalid value or type"),
    ),
});

export const emailInputIssues = (cause: Schema.SchemaError): readonly EmailInputIssue[] =>
  formatIssue(cause.issue)
    .issues.slice(0, 16)
    .map((issue) => {
      const path = (issue.path ?? [])
        .map((part) =>
          Match.value(part).pipe(
            Match.when(Predicate.isString, (field) =>
              validationFields.some((allowed) => allowed === field) ? field : "<unsupported>",
            ),
            Match.when(Predicate.isNumber, String),
            Match.orElse(() => "<unsupported>"),
          ),
        )
        .join(".");

      const rootField = issue.path?.[0];

      const publicPath =
        rootField === "apiKey" ||
        rootField === "apiToken" ||
        rootField === "serverToken" ||
        rootField === "secretKey" ||
        rootField === "accessToken" ||
        rootField === "accessKeyId" ||
        rootField === "secretAccessKey" ||
        rootField === "sessionToken"
          ? rootField
          : path;

      return { path: publicPath.length === 0 ? "<root>" : publicPath, problem: issue.message };
    });
