import { Effect, Predicate, Schema, Struct, UndefinedOr } from "effect";
import type { Result } from "effect";
import { EmailMailboxSchema } from "./email-address.js";
import { EmailInvalidMessage } from "./email-invalid-message.js";
import { emailInputIssues } from "./email-input-issues.js";
import {
  EmailIdempotencyKeySchema,
  EmailMessageSchema,
  parseEmailMessage,
  maxEmailBodyCharacters,
  maxEmailSubjectCharacters,
} from "./email-message.js";
import type { EmailMessage } from "./email-message.js";
import { ownEmailExecutionMetadata } from "./email-preparation.js";
import type { EmailExecutionMetadata, PreparedEmailSubmission } from "./email-preparation.js";

export const EmailTemplateSchema = EmailMessageSchema.mapFields(Struct.omit(["to", "cc", "bcc"]));

export type EmailTemplateInput = typeof EmailTemplateSchema.Encoded;

const EmailTemplateVariables = Schema.Record(
  Schema.String.check(Schema.isMaxLength(64), Schema.isPattern(/^[A-Za-z0-9_-]+$/u)),
  Schema.Union([Schema.String.check(Schema.isMaxLength(10_000)), Schema.Finite, Schema.Boolean]),
).check(
  Schema.makeFilter((variables) => Object.keys(variables).length <= 64, {
    expected: "at most 64 template variables",
  }),
);

export const EmailPersonalizedRecipientSchema = Schema.Struct({
  idempotencyKey: Schema.optionalKey(EmailIdempotencyKeySchema),
  to: EmailMailboxSchema,
  variables: EmailTemplateVariables,
});

export type EmailPersonalizedRecipientInput = typeof EmailPersonalizedRecipientSchema.Encoded;

export const EmailPersonalizedInputSchema = Schema.Struct({
  message: EmailTemplateSchema,
  recipients: Schema.NonEmptyArray(EmailPersonalizedRecipientSchema).check(Schema.isMaxLength(500)),
}).check(
  Schema.makeFilter(
    (input) => {
      const addresses = input.recipients.map((recipient) =>
        (Predicate.isString(recipient.to) ? recipient.to : recipient.to.address).toLowerCase(),
      );

      const keys = input.recipients.flatMap((recipient) =>
        recipient.idempotencyKey === undefined ? [] : [recipient.idempotencyKey],
      );

      return new Set(addresses).size === addresses.length && new Set(keys).size === keys.length;
    },
    { expected: "distinct personalized mailboxes and distinct per-recipient idempotency keys" },
  ),
);

export type EmailPersonalizedInput = typeof EmailPersonalizedInputSchema.Encoded;

const decodePersonalizedInput = Schema.decodeUnknownEffect(EmailPersonalizedInputSchema, {
  errors: "all",
  onExcessProperty: "error",
});

const renderEmailTemplateText = Effect.fnUntraced(function* renderEmailTemplateText(
  template: string,
  variables: typeof EmailTemplateVariables.Type,
  path: "subject" | "body.text" | "body.html",
): Effect.fn.Return<string, EmailInvalidMessage> {
  const replacements = new Map(
    Object.entries(variables).map(([key, variable]) => {
      const value = String(variable);

      const replacement =
        path === "body.html"
          ? value
              .replaceAll("&", "&amp;")
              .replaceAll("<", "&lt;")
              .replaceAll(">", "&gt;")
              .replaceAll('"', "&quot;")
              .replaceAll("'", "&#39;")
          : value;

      return [key, replacement] as const;
    }),
  );

  let missing = false;
  let expandedLength = template.length;

  for (const placeholder of template.matchAll(/%recipient\.(?<key>[A-Za-z0-9_-]+)%/gu)) {
    const replacement = replacements.get(placeholder[1] ?? "");

    if (replacement === undefined) {
      missing = true;
    } else {
      expandedLength += replacement.length - placeholder[0].length;
    }
  }

  if (missing || template.replaceAll(/%recipient\.[A-Za-z0-9_-]+%/gu, "").includes("%recipient.")) {
    return yield* new EmailInvalidMessage({
      issues: [
        {
          path,
          problem: "Template variables must be present and use the supported placeholder syntax",
        },
      ],
    });
  }

  const maximum = path === "subject" ? maxEmailSubjectCharacters : maxEmailBodyCharacters;

  if (expandedLength > maximum) {
    return yield* new EmailInvalidMessage({
      issues: [{ path, problem: "Expanded template text exceeds the message content budget" }],
    });
  }

  return template.replaceAll(
    /%recipient\.(?<key>[A-Za-z0-9_-]+)%/gu,
    (_placeholder, key: string) => replacements.get(key) ?? "",
  );
});

const renderParsedEmailPersonalization = Effect.fnUntraced(
  function* renderParsedEmailPersonalization(
    message: typeof EmailTemplateSchema.Type,
    recipient: typeof EmailPersonalizedRecipientSchema.Type,
  ): Effect.fn.Return<EmailMessage, EmailInvalidMessage> {
    const subject = yield* renderEmailTemplateText(message.subject, recipient.variables, "subject");
    const body = { ...message.body };

    if (body.text !== undefined) {
      body.text = yield* renderEmailTemplateText(body.text, recipient.variables, "body.text");
    }

    if (body.html !== undefined) {
      body.html = yield* renderEmailTemplateText(body.html, recipient.variables, "body.html");
    }

    return yield* parseEmailMessage({ ...message, body, subject, to: recipient.to });
  },
);

export const renderEmailPersonalizedMessage = Effect.fnUntraced(
  function* renderEmailPersonalizedMessage(
    message: EmailTemplateInput,
    recipient: EmailPersonalizedRecipientInput,
  ): Effect.fn.Return<EmailMessage, EmailInvalidMessage> {
    const parsed = yield* decodePersonalizedInput({ message, recipients: [recipient] }).pipe(
      Effect.mapError((cause) => new EmailInvalidMessage({ issues: emailInputIssues(cause) })),
    );

    return yield* renderParsedEmailPersonalization(parsed.message, parsed.recipients[0]);
  },
);

export const prepareEmailPersonalization = Effect.fnUntraced(function* prepareEmailPersonalization(
  input: EmailPersonalizedInput,
  executionMetadata?: EmailExecutionMetadata,
): Effect.fn.Return<
  readonly Result.Result<PreparedEmailSubmission, EmailInvalidMessage>[],
  EmailInvalidMessage
> {
  const context = UndefinedOr.match(executionMetadata, {
    onDefined: (metadata) => ({ executionMetadata: ownEmailExecutionMetadata(metadata) }),
    onUndefined: () => ({}),
  });

  const parsed = yield* decodePersonalizedInput(input).pipe(
    Effect.mapError((cause) => new EmailInvalidMessage({ issues: emailInputIssues(cause) })),
  );

  return yield* Effect.forEach(
    parsed.recipients,
    (recipient) =>
      renderParsedEmailPersonalization(parsed.message, recipient).pipe(
        Effect.map((message) =>
          Object.freeze({
            ...context,
            submission: Object.freeze({ message, ...Struct.pick(recipient, ["idempotencyKey"]) }),
          }),
        ),
        Effect.result,
      ),
    { concurrency: 1 },
  );
});
