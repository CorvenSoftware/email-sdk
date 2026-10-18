import {
  DateTime,
  Duration,
  Effect,
  Layer,
  Match,
  Option,
  Predicate,
  Redacted,
  Schema,
} from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import type { HttpClientResponse } from "effect/http";
import {
  EmailSenderCapabilitiesSchema,
  ownEmailSenderCapabilities,
  validateEmailCapabilities,
} from "./email-capabilities.js";
import { EmailConfigurationError } from "./email-configuration-error.js";
import { emailInputIssues } from "./email-input-issues.js";
import { emailHttpPersonalization, emailHttpSenderLayer } from "./email-http-protocol.js";
import { EmailHttpCredentialSchema } from "./email-http-credential.js";
import { parseEmailHttpRetryAfterMillis } from "./email-http-retry-after.js";
import { EmailDeliveryUnknown } from "./email-delivery-unknown.js";
import type { EmailSubmissionError } from "./email-errors.js";
import { formatEmailTagLabel } from "./email-message-metadata.js";
import { EmailInvalidMessage } from "./email-invalid-message.js";
import { EmailBodySchema, EmailMessageIdSchema, EmailReceiptSchema } from "./email-message.js";
import type { EmailMessage, EmailMessageInput } from "./email-message.js";
import type { EmailSendOptionsInput } from "./email-preparation.js";
import { preflightEmailMessage } from "./email-preflight.js";
import { parseEmailReplayPolicy } from "./email-submission-policy.js";
import type { EmailHttpPersonalizationProtocol } from "./email-http-protocol.js";
import type { EmailMailbox } from "./email-address.js";
import { emailAttachmentMimeType } from "./email-attachment.js";
import { EmailAddressSchema, emailMailboxAddress } from "./email-address.js";
import { EmailRejected } from "./email-rejected.js";
import { EmailSenderIdempotencySchema } from "./email-sender.js";
import type { EmailSubmission, EmailSender } from "./email-sender.js";
import { Email, emailLayer } from "./email-service.js";
import type {
  EmailDeliveryPolicy,
  EmailRetryObserver,
  EmailRetryRestriction,
} from "./email-service.js";

export const sendgridEmailCapabilities = ownEmailSenderCapabilities(
  EmailSenderCapabilitiesSchema.make({
    attachmentContentTypes: "Both",
    attachments: true,
    headers: "Unique",
    inlineAttachments: true,
    metadata: true,
    scheduling: true,
    tags: { asciiOnly: false, maxCount: 10 },
  }),
);

export interface SendgridEmailOptions {
  readonly apiKey: Redacted.Redacted;
  readonly region?: "Global" | "Europe";
}

const SendgridConfiguration = Schema.Struct({
  apiKey: EmailHttpCredentialSchema,
  region: Schema.optionalKey(Schema.Literals(["Global", "Europe"])),
});

const formatSendgridMailbox = (mailbox: EmailMailbox) =>
  Schema.is(EmailAddressSchema)(mailbox)
    ? { email: mailbox }
    : { email: mailbox.address, name: mailbox.name };

const sendgridPersonalization = (message: EmailMessage) => ({
  bcc: message.bcc?.map(formatSendgridMailbox),
  cc: message.cc?.map(formatSendgridMailbox),
  custom_args: message.metadata,
  headers:
    message.headers === undefined
      ? undefined
      : Object.fromEntries(message.headers.map((header) => [header.name, header.value])),
  to: message.to.map(formatSendgridMailbox),
});

type SendgridNativePersonalization = ReturnType<typeof sendgridPersonalization> & {
  readonly subject: string;
  readonly substitutions: Readonly<Record<string, string>>;
};

interface SendgridNativeEnvelope {
  readonly content: readonly { readonly type: string; readonly value: string }[];
  readonly personalizations: readonly SendgridNativePersonalization[];
}

const SendgridPersonalizedBody = Schema.toType(EmailBodySchema).check(
  Schema.makeFilter((body) => new TextEncoder().encode(JSON.stringify(body)).byteLength <= 8192, {
    expected: "native SendGrid personalized body JSON within 8192 UTF-8 bytes",
  }),
);

const supportsSendgridScheduledInstant = (sendAt: DateTime.Utc, nowMillis: number): boolean => {
  const instantMillis = DateTime.toEpochMillis(sendAt);
  const aheadMillis = instantMillis - nowMillis;

  return (
    instantMillis % 1000 === 0 &&
    aheadMillis > 0 &&
    aheadMillis <= Duration.toMillis(Duration.hours(72))
  );
};

const parseMessageId = Schema.decodeUnknownOption(EmailMessageIdSchema);

const classifySendgridRejection = (
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<never, EmailSubmissionError> => {
  const { status } = response;

  if (status >= 500) {
    return Effect.fail(
      new EmailDeliveryUnknown({ provider: "sendgrid", reason: "server-error", status }),
    );
  }

  const reason = Match.value(status).pipe(
    Match.when(
      (code) => code === 401 || code === 403,
      () => "authentication" as const,
    ),
    Match.when(
      (code) => code === 400 || code === 413,
      () => "invalid-message" as const,
    ),
    Match.when(429, () => "rate-limited" as const),
    Match.when(
      (code) => code === 404 || code === 405,
      () => "rejected" as const,
    ),
    Match.orElse(() => "unexpected-status" as const),
  );

  if (reason === "unexpected-status") {
    return Effect.fail(
      new EmailDeliveryUnknown({ provider: "sendgrid", reason: "unexpected-status", status }),
    );
  }

  const retryAfter = parseEmailHttpRetryAfterMillis(response.headers["retry-after"]);

  return Effect.fail(
    Option.match(retryAfter, {
      onNone: () => new EmailRejected({ provider: "sendgrid", reason, status }),
      onSome: (retryAfterMillis) =>
        new EmailRejected({
          provider: "sendgrid",
          reason,
          retryAfterMillis,
          status,
        }),
    }),
  );
};

const validateSendgridEmail = Effect.fnUntraced(function* validateSendgridEmail(
  message: EmailSubmission["message"],
): Effect.fn.Return<void, EmailInvalidMessage> {
  yield* validateEmailCapabilities(message, sendgridEmailCapabilities);
  const issues = [];

  if (
    !Schema.is(EmailAddressSchema)(message.from) &&
    message.from.name !== undefined &&
    !/^[\u0020-\u007E]+$/u.test(message.from.name)
  ) {
    issues.push({ path: "from", problem: "SendGrid sender names require ASCII characters" });
  }

  if (message.headers?.some((header) => /^(?:x-sg-id|x-sg-eid)$/iu.test(header.name)) === true) {
    issues.push({
      path: "headers",
      problem: "SendGrid reserved headers cannot be overridden",
    });
  }

  if (
    message.tags?.some(
      (tag) =>
        tag.name.includes(":") ||
        !/^[\u0020-\u007E]+$/u.test(formatEmailTagLabel(tag)) ||
        tag.name.length + tag.value.length + 1 > 255,
    ) === true
  ) {
    issues.push({
      path: "tags",
      problem:
        "SendGrid categories require ASCII name:value pairs up to 255 characters and colon-free names",
    });
  }

  if (
    message.metadata !== undefined &&
    (Object.keys(message.metadata).length === 0 ||
      new TextEncoder().encode(JSON.stringify(message.metadata)).byteLength >= 10_000)
  ) {
    issues.push({
      path: "metadata",
      problem: "SendGrid custom arguments must be nonempty and less than 10000 UTF-8 bytes",
    });
  }

  if (
    message.sendAt !== undefined &&
    !supportsSendgridScheduledInstant(message.sendAt, DateTime.toEpochMillis(yield* DateTime.now))
  ) {
    issues.push({
      path: "sendAt",
      problem: "SendGrid scheduling requires a future whole UTC second within 72 hours",
    });
  }

  for (const [path, mailboxes] of [
    ["to", [...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])]],
    ["replyTo", message.replyTo ?? []],
  ] as const) {
    const addresses = mailboxes.map((mailbox) => emailMailboxAddress(mailbox).toLowerCase());

    if (new Set(addresses).size !== addresses.length) {
      issues.push({ path, problem: "SendGrid recipient addresses must be distinct" });
    }
  }

  if (issues.length > 0) {
    return yield* new EmailInvalidMessage({ issues });
  }

  return undefined;
});

const sendgridPreflight = {
  capabilities: sendgridEmailCapabilities,
  idempotency: EmailSenderIdempotencySchema.cases.None.make({}),
  provider: "sendgrid",
  validate: validateSendgridEmail,
};

const sendgridProtocol = (configuration: typeof SendgridConfiguration.Type) => {
  const endpoint =
    configuration.region === "Europe"
      ? "https://api.eu.sendgrid.com/v3/mail/send"
      : "https://api.sendgrid.com/v3/mail/send";

  const request = Effect.fnUntraced(function* buildSendgridRequest(
    submission: EmailSubmission,
    native?: SendgridNativeEnvelope,
  ): Effect.fn.Return<HttpClientRequest.HttpClientRequest, EmailRejected> {
    const { message } = submission;
    const content = [];

    if (message.body.text !== undefined) {
      content.push({ type: "text/plain", value: message.body.text });
    }

    if (message.body.html !== undefined) {
      content.push({ type: "text/html", value: message.body.html });
    }

    return yield* HttpClientRequest.post(endpoint).pipe(
      HttpClientRequest.bearerToken(Redacted.value(configuration.apiKey)),
      HttpClientRequest.acceptJson,
      HttpClientRequest.bodyJson({
        attachments: message.attachments?.map((attachment) => ({
          content: attachment.contentBase64,
          content_id: attachment.contentId,
          disposition:
            attachment.disposition ??
            (attachment.contentId === undefined ? "attachment" : "inline"),
          filename: attachment.filename,
          type: emailAttachmentMimeType(attachment),
        })),
        categories: message.tags?.map(formatEmailTagLabel),
        content: native?.content ?? content,
        from: formatSendgridMailbox(message.from),
        mail_settings: { footer: { enable: false }, sandbox_mode: { enable: false } },
        personalizations: native?.personalizations ?? [sendgridPersonalization(message)],
        reply_to_list: message.replyTo?.map(formatSendgridMailbox),
        send_at:
          message.sendAt === undefined ? undefined : DateTime.toEpochMillis(message.sendAt) / 1000,
        subject: message.subject,
        tracking_settings: {
          click_tracking: { enable: false, enable_text: false },
          ganalytics: { enable: false },
          open_tracking: { enable: false },
          subscription_tracking: { enable: false },
        },
      }),
      Effect.mapError(() => new EmailRejected({ provider: "sendgrid", reason: "invalid-message" })),
    );
  });

  const respond = Effect.fnUntraced(function* readSendgridAcknowledgement(
    response: HttpClientResponse.HttpClientResponse,
  ): Effect.fn.Return<typeof EmailReceiptSchema.cases.Accepted.Type, EmailSubmissionError> {
    if (response.status !== 202) {
      return yield* classifySendgridRejection(response);
    }

    return Object.freeze(
      Option.match(parseMessageId(response.headers["x-message-id"]), {
        onNone: () => EmailReceiptSchema.cases.Accepted.make({ provider: "sendgrid" }),
        onSome: (messageId) =>
          EmailReceiptSchema.cases.Accepted.make({ messageId, provider: "sendgrid" }),
      }),
    );
  });

  return {
    ...sendgridPreflight,
    request,
    respond,
    span: "SendGrid.submit",
  };
};

export const preflightSendgridEmail = (
  message: EmailMessageInput,
  options?: EmailSendOptionsInput,
) => preflightEmailMessage(sendgridPreflight, message, options);

export const sendgridSenderLayer = (
  options: SendgridEmailOptions,
): Layer.Layer<EmailSender, EmailConfigurationError, HttpClient.HttpClient> =>
  emailHttpSenderLayer(SendgridConfiguration, options, sendgridProtocol);

export const sendgridEmailLayer = (
  options: SendgridEmailOptions,
  policy?: EmailDeliveryPolicy,
  observer?: EmailRetryObserver,
  restriction?: EmailRetryRestriction,
): Layer.Layer<Email, EmailConfigurationError, HttpClient.HttpClient> =>
  emailLayer(policy, observer, restriction).pipe(Layer.provide(sendgridSenderLayer(options)));

const sendgridPersonalizedTokens = (messages: readonly EmailMessage[]) => {
  for (let index = 0; index < 64; index += 1) {
    const prefix = `-corven-${index}-`;

    const collision = messages.some((message) =>
      [message.subject, message.body.text, message.body.html, JSON.stringify(message.replyTo)].some(
        (value) => value?.includes(prefix) === true,
      ),
    );

    if (!collision) {
      return Option.some({ html: `${prefix}html-`, text: `${prefix}text-` });
    }
  }

  return Option.none();
};

export const sendgridPersonalizedEmailLayer = (
  options: SendgridEmailOptions,
  policy?: EmailDeliveryPolicy,
  observer?: EmailRetryObserver,
  restriction?: EmailRetryRestriction,
): Layer.Layer<Email, EmailConfigurationError, HttpClient.HttpClient> =>
  Layer.unwrap(
    Effect.gen(function* configureSendgridPersonalization() {
      const configuration = yield* Schema.decodeEffect(SendgridConfiguration, {
        errors: "all",
        onExcessProperty: "error",
      })(options);

      const protocol = sendgridProtocol(configuration);

      const resolvedPolicy = yield* parseEmailReplayPolicy(protocol.idempotency, policy);

      return Layer.effect(
        Email,
        Effect.gen(function* acquireSendgridPersonalization() {
          const email = yield* Email;
          const client = yield* HttpClient.HttpClient;

          const request: EmailHttpPersonalizationProtocol["request"] = Effect.fnUntraced(
            function* buildNativeSendgridRequest(messages) {
              const [first] = messages;

              const tokens = yield* Effect.fromOption(
                sendgridPersonalizedTokens(messages),
                () =>
                  new EmailInvalidMessage({
                    issues: [
                      {
                        path: "body",
                        problem:
                          "Native personalization requires collision-free substitution tokens",
                      },
                    ],
                  }),
              );

              const personalizations = messages.map((message) => ({
                ...sendgridPersonalization(message),
                subject: message.subject,
                substitutions: Object.fromEntries([
                  ...(message.body.text === undefined
                    ? []
                    : [[tokens.text, message.body.text] as const]),
                  ...(message.body.html === undefined
                    ? []
                    : [[tokens.html, message.body.html] as const]),
                ]),
              }));

              const built = yield* protocol.request(
                { message: first },
                {
                  content: [
                    ...(first.body.text === undefined
                      ? []
                      : [{ type: "text/plain", value: tokens.text }]),
                    ...(first.body.html === undefined
                      ? []
                      : [{ type: "text/html", value: tokens.html }]),
                  ],
                  personalizations,
                },
              );

              if (
                !Predicate.isTagged(built.body, "Uint8Array") ||
                built.body.contentLength > 30_000_000
              ) {
                return yield* new EmailInvalidMessage({
                  issues: [
                    {
                      path: "body",
                      problem: "Native personalized request exceeds 30000000 UTF-8 bytes",
                    },
                  ],
                });
              }

              return built;
            },
          );

          const sendPersonalized = emailHttpPersonalization(
            email,
            {
              idempotency: protocol.idempotency,
              provider: protocol.provider,
              request,
              respond: protocol.respond,
              spans: { send: "SendGrid.sendPersonalized", submit: "SendGrid.submitPersonalized" },
              validate: protocol.validate,
              validateItem: (message) =>
                Schema.decodeEffect(SendgridPersonalizedBody)(message.body).pipe(
                  Effect.asVoid,
                  Effect.mapError(
                    () =>
                      new EmailInvalidMessage({
                        issues: [
                          {
                            path: "body",
                            problem: "Native personalized body exceeds 8192 UTF-8 JSON bytes",
                          },
                        ],
                      }),
                  ),
                ),
            },
            client,
            resolvedPolicy,
            observer,
            restriction,
          );

          return Email.of({ ...email, personalization: "NativeAudience", sendPersonalized });
        }),
      ).pipe(
        Layer.provide(sendgridEmailLayer(configuration, resolvedPolicy, observer, restriction)),
      );
    }).pipe(
      Effect.mapError((cause) => new EmailConfigurationError({ issues: emailInputIssues(cause) })),
    ),
  );
