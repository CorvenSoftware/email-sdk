import { Effect, Match, Redacted, Schema } from "effect";
import { HttpClientRequest } from "effect/http";
import type { HttpClientResponse } from "effect/http";
import { defineEmailHttpProvider } from "./email-provider.js";
import { EmailHttpCredentialTextSchema } from "./email-http-credential.js";
import { EmailSenderCapabilitiesSchema, ownEmailSenderCapabilities } from "./email-capabilities.js";
import { formatEmailMailbox } from "./email-address.js";
import { EmailDeliveryUnknown } from "./email-delivery-unknown.js";
import type { EmailSubmissionError } from "./email-errors.js";
import { readEmailHttpJson } from "./email-http-response.js";
import { parseEmailHttpRetryAfterMillis } from "./email-http-retry-after.js";
import { EmailMessageIdSchema, EmailReceiptSchema } from "./email-message.js";
import type { EmailReceipt } from "./email-message.js";
import { EmailRejected } from "./email-rejected.js";
import { formatEmailTagLabel } from "./email-message-metadata.js";
import { EmailInvalidMessage } from "./email-invalid-message.js";
import { EmailSenderIdempotencySchema } from "./email-sender.js";
import type { EmailSubmission } from "./email-sender.js";

export const postmarkEmailCapabilities = ownEmailSenderCapabilities(
  EmailSenderCapabilitiesSchema.make({
    attachmentContentTypes: "Explicit",
    attachments: true,
    headers: "Repeated",
    inlineAttachments: true,
    metadata: true,
    scheduling: false,
    tags: Object.freeze({ asciiOnly: false, maxCount: 1 }),
  }),
);

export interface PostmarkEmailOptions {
  readonly serverToken: Redacted.Redacted;
  readonly messageStream?: string;
}

const PostmarkConfiguration = Schema.Struct({
  messageStream: Schema.optionalKey(
    Schema.String.check(
      Schema.isMaxLength(30),
      Schema.isPattern(/^[A-Za-z][A-Za-z0-9_-]*$/u, {
        expected: "a Postmark stream identifier starting with a letter",
      }),
    ),
  ),
  serverToken: Schema.Redacted(
    EmailHttpCredentialTextSchema.check(
      Schema.makeFilter((token) => token.toUpperCase() !== "POSTMARK_API_TEST", {
        expected: "a server token for submission, not Postmark's validation-only token",
      }),
    ),
  ),
});

const PostmarkResponseCode = Schema.Struct({
  ErrorCode: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

const PostmarkAcknowledgement = Schema.Struct({
  ErrorCode: Schema.Literal(0),
  MessageID: EmailMessageIdSchema,
});

const PostmarkRejectionCode = Schema.Literals([
  10, 11, 300, 402, 403, 406, 410, 411, 412, 413, 422, 1235, 1236, 1480,
]);

const rejectPostmarkCode = (
  code: number,
  status: number,
): Effect.Effect<never, EmailSubmissionError> => {
  if (code === 100 || code === 101) {
    return Effect.fail(
      new EmailDeliveryUnknown({
        provider: "postmark",
        providerCode: code,
        reason: "server-error",
        status,
      }),
    );
  }

  if (!Schema.is(PostmarkRejectionCode)(code)) {
    return Effect.fail(
      new EmailDeliveryUnknown({
        provider: "postmark",
        providerCode: code,
        reason: "invalid-response",
        status,
      }),
    );
  }

  const reason = Match.value(code).pipe(
    Match.when(10, () => "authentication" as const),
    Match.when(
      (value) => [300, 402, 403, 410, 411].includes(value),
      () => "invalid-message" as const,
    ),
    Match.orElse(() => "rejected" as const),
  );

  return Effect.fail(
    new EmailRejected({ provider: "postmark", providerCode: code, reason, status }),
  );
};

const validatePostmarkMessage = Effect.fnUntraced(function* validatePostmarkMessage(
  message: EmailSubmission["message"],
): Effect.fn.Return<void, EmailInvalidMessage> {
  const fields = [
    ["from", [message.from]],
    ["to", message.to],
    ["cc", message.cc ?? []],
    ["bcc", message.bcc ?? []],
    ["replyTo", message.replyTo ?? []],
  ] as const;

  const issues = fields.flatMap(([path, mailboxes]) =>
    mailboxes.some((mailbox) => formatEmailMailbox(mailbox).length > 255)
      ? [{ path, problem: "Formatted mailbox exceeds provider length limit" }]
      : [],
  );

  if (issues.length > 0) {
    return yield* new EmailInvalidMessage({ issues });
  }

  if (message.tags?.some((tag) => tag.name.includes(":")) === true) {
    return yield* new EmailInvalidMessage({
      issues: [
        { path: "tags", problem: "Postmark tag names cannot contain the name/value separator" },
      ],
    });
  }

  return undefined;
});

const postmarkPreflight = {
  capabilities: postmarkEmailCapabilities,
  idempotency: EmailSenderIdempotencySchema.cases.None.make({}),
  provider: "postmark",
  validate: validatePostmarkMessage,
};

const postmarkProvider = defineEmailHttpProvider({
  configuration: PostmarkConfiguration,
  makeProtocol: ({ serverToken, messageStream }) => {
    const request = Effect.fnUntraced(function* buildPostmarkRequest(
      submission: EmailSubmission,
    ): Effect.fn.Return<HttpClientRequest.HttpClientRequest, EmailRejected> {
      const { message } = submission;
      const firstTag = message.tags?.[0];

      return yield* HttpClientRequest.post("https://api.postmarkapp.com/email").pipe(
        HttpClientRequest.setHeader("X-Postmark-Server-Token", Redacted.value(serverToken)),
        HttpClientRequest.acceptJson,
        HttpClientRequest.bodyJson({
          Attachments: message.attachments?.map((attachment) => ({
            Content: attachment.contentBase64,
            ContentID:
              attachment.contentId === undefined ? undefined : `cid:${attachment.contentId}`,
            ContentType: attachment.contentType,
            Name: attachment.filename,
          })),
          Bcc: message.bcc?.map(formatEmailMailbox).join(", "),
          Cc: message.cc?.map(formatEmailMailbox).join(", "),
          From: formatEmailMailbox(message.from),
          Headers: message.headers?.map((header) => ({ Name: header.name, Value: header.value })),
          HtmlBody: message.body.html,
          MessageStream: messageStream ?? "outbound",
          Metadata: message.metadata,
          ReplyTo: message.replyTo?.map(formatEmailMailbox).join(", "),
          Subject: message.subject,
          Tag: firstTag === undefined ? undefined : formatEmailTagLabel(firstTag),
          TextBody: message.body.text,
          To: message.to.map(formatEmailMailbox).join(", "),
          TrackLinks: "None",
          TrackOpens: false,
        }),
        Effect.mapError(
          () => new EmailRejected({ provider: "postmark", reason: "invalid-message" }),
        ),
      );
    });

    const respond = Effect.fnUntraced(function* readPostmarkAcknowledgement(
      response: HttpClientResponse.HttpClientResponse,
    ): Effect.fn.Return<EmailReceipt, EmailSubmissionError> {
      const { status } = response;

      if (status >= 500) {
        return yield* new EmailDeliveryUnknown({
          provider: "postmark",
          reason: "server-error",
          status,
        });
      }

      if (status === 401) {
        return yield* new EmailRejected({
          provider: "postmark",
          reason: "authentication",
          status,
        });
      }

      if (status === 429) {
        const delay = parseEmailHttpRetryAfterMillis(response.headers["retry-after"]);

        return yield* Match.value(delay).pipe(
          Match.tag("Some", ({ value }) =>
            Effect.fail(
              new EmailRejected({
                provider: "postmark",
                reason: "rate-limited",
                retryAfterMillis: value,
                status,
              }),
            ),
          ),
          Match.tag("None", () =>
            Effect.fail(
              new EmailRejected({ provider: "postmark", reason: "rate-limited", status }),
            ),
          ),
          Match.exhaustive,
        );
      }

      if (status !== 200 && status !== 422) {
        if (status >= 400 && status < 500) {
          return yield* new EmailRejected({ provider: "postmark", reason: "rejected", status });
        }

        return yield* new EmailDeliveryUnknown({
          provider: "postmark",
          reason: "unexpected-status",
          status,
        });
      }

      const body = yield* readEmailHttpJson(response, "postmark");

      const result = yield* Schema.decodeUnknownEffect(PostmarkResponseCode)(body).pipe(
        Effect.mapError(
          () =>
            new EmailDeliveryUnknown({
              provider: "postmark",
              reason: "invalid-response",
              status,
            }),
        ),
      );

      if (result.ErrorCode !== 0) {
        return yield* rejectPostmarkCode(result.ErrorCode, status);
      }

      if (status !== 200) {
        return yield* new EmailDeliveryUnknown({
          provider: "postmark",
          reason: "unexpected-status",
          status,
        });
      }

      const acknowledgement = yield* Schema.decodeUnknownEffect(PostmarkAcknowledgement)(body).pipe(
        Effect.mapError(
          () =>
            new EmailDeliveryUnknown({
              provider: "postmark",
              reason: "invalid-response",
              status,
            }),
        ),
      );

      return EmailReceiptSchema.cases.Accepted.make({
        messageId: acknowledgement.MessageID,
        provider: "postmark",
      });
    });

    return Effect.succeed({ request, respond });
  },
  profile: postmarkPreflight,
  span: "Postmark.submit",
});

export const preflightPostmarkEmail = postmarkProvider.preflight;

export const postmarkSenderLayer = postmarkProvider.senderLayer;

export const postmarkEmailLayer = postmarkProvider.emailLayer;
