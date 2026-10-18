import { DateTime, Effect, Layer, Match, Option, Schema, Struct } from "effect";
import type { Redacted } from "effect";
import { Base64 } from "effect/encoding";
import { HttpClient, HttpClientRequest } from "effect/http";
import type { HttpClientResponse } from "effect/http";
import { emailMailboxAddress, formatEmailMailbox } from "./email-address.js";
import type { EmailMailbox } from "./email-address.js";
import {
  EmailSenderCapabilitiesSchema,
  ownEmailSenderCapabilities,
  validateEmailCapabilities,
} from "./email-capabilities.js";
import { EmailConfigurationError } from "./email-configuration-error.js";
import { emailHttpPersonalization, emailHttpSenderLayer } from "./email-http-protocol.js";
import type { EmailHttpPersonalizationProtocol } from "./email-http-protocol.js";
import { EmailHttpCredentialSchema } from "./email-http-credential.js";
import { EmailDeliveryUnknown } from "./email-delivery-unknown.js";
import type { EmailSubmissionError } from "./email-errors.js";
import { readEmailHttpJson } from "./email-http-response.js";
import { parseEmailHttpRetryAfterMillis } from "./email-http-retry-after.js";
import { emailInputIssues } from "./email-input-issues.js";
import type { EmailInputIssue } from "./email-input-issues.js";
import { formatEmailTagLabel } from "./email-message-metadata.js";
import { EmailInvalidMessage } from "./email-invalid-message.js";
import { EmailMessageIdSchema, EmailReceiptSchema } from "./email-message.js";
import type { EmailMessage, EmailMessageInput } from "./email-message.js";
import type { EmailSendOptionsInput } from "./email-preparation.js";
import { preflightEmailMessage } from "./email-preflight.js";
import { EmailRejected } from "./email-rejected.js";
import { EmailSenderIdempotencySchema } from "./email-sender.js";
import type { EmailSubmission, EmailSender } from "./email-sender.js";
import { Email, emailLayer } from "./email-service.js";
import { parseEmailReplayPolicy } from "./email-submission-policy.js";
import type {
  EmailDeliveryPolicy,
  EmailRetryObserver,
  EmailRetryRestriction,
} from "./email-service.js";

export const mailgunEmailCapabilities = ownEmailSenderCapabilities(
  EmailSenderCapabilitiesSchema.make({
    attachmentContentTypes: "Explicit",
    attachments: true,
    headers: "Repeated",
    inlineAttachments: true,
    metadata: true,
    scheduling: true,
    tags: { asciiOnly: false, maxCount: 3 },
  }),
);

export interface MailgunEmailOptions {
  readonly apiKey: Redacted.Redacted;
  readonly domain: string;
  readonly region?: "UnitedStates" | "Europe";
}

const MailgunConfiguration = Schema.Struct({
  apiKey: EmailHttpCredentialSchema,
  domain: Schema.String.check(
    Schema.isMaxLength(253),
    Schema.isPattern(
      /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u,
      {
        expected: "a lowercase ASCII DNS sending domain without path or port",
      },
    ),
  ),
  region: Schema.optionalKey(Schema.Literals(["UnitedStates", "Europe"])),
});

const MailgunAcknowledgement = Schema.Struct({ id: EmailMessageIdSchema });

const MailgunMetadataText = Schema.String.check(
  Schema.makeFilter(
    (text) => {
      for (const character of text) {
        const point = character.codePointAt(0) ?? 0;

        if (point < 32 || point === 127 || (point >= 0xd8_00 && point <= 0xdf_ff)) {
          return false;
        }
      }

      return true;
    },
    { expected: "control-free valid Unicode multipart metadata" },
  ),
);

const mailgunOptionFields = (message: EmailMessage): readonly (readonly [string, string])[] => {
  const fields: (readonly [string, string])[] = [
    ["o:tracking", "no"],
    ["o:tracking-clicks", "no"],
    ["o:tracking-opens", "no"],
  ];

  for (const replyTo of message.replyTo ?? []) {
    fields.push(["h:Reply-To", formatEmailMailbox(replyTo)]);
  }

  for (const header of message.headers ?? []) {
    fields.push([`h:${header.name}`, header.value]);
  }

  for (const tag of message.tags ?? []) {
    fields.push(["o:tag", formatEmailTagLabel(tag)]);
  }

  for (const [name, value] of Object.entries(message.metadata ?? {})) {
    fields.push([`v:${name}`, value]);
  }

  if (message.sendAt !== undefined) {
    fields.push(["o:deliverytime", DateTime.toDateUtc(message.sendAt).toUTCString()]);
  }

  return fields;
};

const validateMailgunEmail = Effect.fnUntraced(function* validateMailgunEmail(
  message: EmailMessage,
): Effect.fn.Return<void, EmailInvalidMessage> {
  yield* validateEmailCapabilities(message, mailgunEmailCapabilities);
  const tags = message.tags?.map((tag) => formatEmailTagLabel(tag).toLowerCase()) ?? [];
  const encoder = new TextEncoder();
  let optionBytes = 0;

  for (const [name, value] of mailgunOptionFields(message)) {
    optionBytes += encoder.encode(name).byteLength + encoder.encode(value).byteLength;
  }

  const checks: readonly { readonly invalid: boolean; readonly issue: EmailInputIssue }[] = [
    {
      invalid: message.headers?.some((header) => /^x-mailgun-/iu.test(header.name)) === true,
      issue: { path: "headers", problem: "Mailgun control headers cannot be overridden" },
    },
    {
      invalid:
        message.attachments?.some(
          (attachment) =>
            attachment.contentId !== undefined &&
            attachment.contentId.toString() !== attachment.filename.toString(),
        ) === true,
      issue: {
        path: "attachments",
        problem: "Mailgun inline content IDs must equal the preserved filename",
      },
    },
    {
      invalid:
        message.tags?.some(
          (tag) =>
            tag.name.includes(":") ||
            tag.name.length + tag.value.length + 1 > 128 ||
            !/^[\u0020-\u007E]+$/u.test(formatEmailTagLabel(tag)),
        ) === true,
      issue: {
        path: "tags",
        problem:
          "Mailgun tags require ASCII name:value pairs up to 128 characters and colon-free names",
      },
    },
    {
      invalid: new Set(tags).size !== tags.length,
      issue: {
        path: "tags",
        problem: "Mailgun tag identities must be distinct case-insensitively",
      },
    },
    {
      invalid: Object.entries(message.metadata ?? {}).some(
        ([name, value]) =>
          !Schema.is(MailgunMetadataText)(name) || !Schema.is(MailgunMetadataText)(value),
      ),
      issue: {
        path: "metadata",
        problem: "Mailgun metadata names and values must be control-free valid Unicode",
      },
    },
    ...(
      [
        ["subject", message.subject],
        ["body.text", message.body.text],
        ["body.html", message.body.html],
      ] as const
    ).map(([path, text]) => ({
      invalid: text !== undefined && /[\uD800-\uDFFF]/u.test(text),
      issue: { path, problem: "Mailgun multipart text must contain valid Unicode" },
    })),
    {
      invalid:
        message.sendAt !== undefined &&
        (DateTime.toEpochMillis(message.sendAt) % 1000 !== 0 ||
          DateTime.toPartsUtc(message.sendAt).year < 1900),
      issue: {
        path: "sendAt",
        problem: "Mailgun scheduling requires whole seconds and an RFC-2822 year of at least 1900",
      },
    },
    {
      invalid: optionBytes > 16 * 1024,
      issue: {
        path: "metadata",
        problem:
          "Mailgun combined option field names and values exceed the local 16 KiB UTF-8 budget",
      },
    },
  ];

  const issues = checks.flatMap((check) => (check.invalid ? [check.issue] : []));

  if (issues.length > 0) {
    return yield* new EmailInvalidMessage({ issues });
  }

  return undefined;
});

const classifyMailgunRejection = (
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<never, EmailSubmissionError> => {
  const { status } = response;

  if (status >= 500) {
    return Effect.fail(
      new EmailDeliveryUnknown({ provider: "mailgun", reason: "server-error", status }),
    );
  }

  const reason = Match.value(status).pipe(
    Match.when(
      (code) => code === 401 || code === 403,
      () => "authentication" as const,
    ),
    Match.when(400, () => "invalid-message" as const),
    Match.when(429, () => "rate-limited" as const),
    Match.when(404, () => "rejected" as const),
    Match.orElse(() => "unexpected-status" as const),
  );

  if (reason === "unexpected-status") {
    return Effect.fail(new EmailDeliveryUnknown({ provider: "mailgun", reason, status }));
  }

  return Effect.fail(
    Option.match(parseEmailHttpRetryAfterMillis(response.headers["retry-after"]), {
      onNone: () => new EmailRejected({ provider: "mailgun", reason, status }),
      onSome: (retryAfterMillis) =>
        new EmailRejected({
          provider: "mailgun",
          reason,
          retryAfterMillis,
          status,
        }),
    }),
  );
};

interface MailgunNativeEnvelope {
  readonly recipients: readonly EmailMailbox[];
  readonly variables: string;
}

const mailgunPreflight = {
  capabilities: mailgunEmailCapabilities,
  idempotency: EmailSenderIdempotencySchema.cases.None.make({}),
  provider: "mailgun",
  validate: validateMailgunEmail,
};

const mailgunProtocol = (configuration: typeof MailgunConfiguration.Type) => {
  const origin =
    configuration.region === "Europe" ? "https://api.eu.mailgun.net" : "https://api.mailgun.net";

  const request = Effect.fnUntraced(function* buildMailgunRequest(
    submission: EmailSubmission,
    native?: MailgunNativeEnvelope,
  ): Effect.fn.Return<HttpClientRequest.HttpClientRequest, EmailRejected> {
    const { message } = submission;
    const body = new FormData();
    body.set("from", formatEmailMailbox(message.from));
    body.set("subject", native === undefined ? message.subject : "%recipient.corven_subject%");

    for (const [name, mailboxes] of [
      ["to", native?.recipients ?? message.to],
      ["cc", message.cc ?? []],
      ["bcc", message.bcc ?? []],
    ] as const) {
      for (const mailbox of mailboxes) {
        body.append(name, formatEmailMailbox(mailbox));
      }
    }

    if (message.body.text !== undefined) {
      body.set("text", native === undefined ? message.body.text : "%recipient.corven_text%");
    }

    if (message.body.html !== undefined) {
      body.set("html", native === undefined ? message.body.html : "%recipient.corven_html%");
    }

    if (native !== undefined) {
      body.set("recipient-variables", native.variables);
    }

    for (const [name, value] of mailgunOptionFields(message)) {
      body.append(name, value);
    }

    for (const attachment of message.attachments ?? []) {
      const bytes = yield* Effect.fromResult(Base64.decode(attachment.contentBase64)).pipe(
        Effect.mapError(
          () => new EmailRejected({ provider: "mailgun", reason: "invalid-message" }),
        ),
      );

      body.append(
        attachment.contentId === undefined ? "attachment" : "inline",
        new Blob([Uint8Array.from(bytes)], { type: attachment.contentType }),
        attachment.filename,
      );
    }

    return HttpClientRequest.post(`${origin}/v3/${configuration.domain}/messages`).pipe(
      HttpClientRequest.basicAuth("api", configuration.apiKey),
      HttpClientRequest.acceptJson,
      HttpClientRequest.bodyFormData(body),
    );
  });

  const respond = Effect.fnUntraced(function* readMailgunAcknowledgement(
    response: HttpClientResponse.HttpClientResponse,
  ): Effect.fn.Return<typeof EmailReceiptSchema.cases.Accepted.Type, EmailSubmissionError> {
    if (response.status !== 200) {
      return yield* classifyMailgunRejection(response);
    }

    const acknowledgement = yield* readEmailHttpJson(response, "mailgun").pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(MailgunAcknowledgement)),
      Effect.mapError(
        () =>
          new EmailDeliveryUnknown({
            provider: "mailgun",
            reason: "invalid-response",
            status: response.status,
          }),
      ),
    );

    return Object.freeze(
      EmailReceiptSchema.cases.Accepted.make({
        messageId: acknowledgement.id,
        provider: "mailgun",
      }),
    );
  });

  return {
    ...mailgunPreflight,
    request,
    respond,
    span: "Mailgun.submit",
  };
};

export const preflightMailgunEmail = (
  message: EmailMessageInput,
  options?: EmailSendOptionsInput,
) => preflightEmailMessage(mailgunPreflight, message, options);

export const mailgunSenderLayer = (
  options: MailgunEmailOptions,
): Layer.Layer<EmailSender, EmailConfigurationError, HttpClient.HttpClient> =>
  emailHttpSenderLayer(MailgunConfiguration, options, mailgunProtocol);

export const mailgunEmailLayer = (
  options: MailgunEmailOptions,
  policy?: EmailDeliveryPolicy,
  observer?: EmailRetryObserver,
  restriction?: EmailRetryRestriction,
): Layer.Layer<Email, EmailConfigurationError, HttpClient.HttpClient> =>
  emailLayer(policy, observer, restriction).pipe(Layer.provide(mailgunSenderLayer(options)));

const MailgunNativeLiteral = Schema.String.check(
  Schema.makeFilter((text) => !text.includes("%recipient"), {
    expected: "literal text without Mailgun recipient interpolation syntax",
  }),
);

const validateMailgunPersonalizedItem = Effect.fnUntraced(function* validateMailgunPersonalizedItem(
  message: EmailMessage,
): Effect.fn.Return<void, EmailInvalidMessage> {
  const fields = [
    ["subject", [message.subject]],
    ["body", [message.body.text ?? "", message.body.html ?? ""]],
    ["from", [formatEmailMailbox(message.from)]],
    ["to", message.to.map(formatEmailMailbox)],
    ["replyTo", (message.replyTo ?? []).map(formatEmailMailbox)],
    ["headers", (message.headers ?? []).flatMap((header) => [header.name, header.value])],
    ["tags", (message.tags ?? []).map(formatEmailTagLabel)],
    ["metadata", Object.entries(message.metadata ?? {}).flat()],
    [
      "attachments",
      (message.attachments ?? []).flatMap((attachment) => [
        attachment.filename,
        attachment.contentId ?? "",
        attachment.contentType,
      ]),
    ],
  ] as const;

  const issues = fields.flatMap(([path, values]) =>
    values.some((value) => !Schema.is(MailgunNativeLiteral)(value))
      ? [
          {
            path,
            problem:
              "Native Mailgun personalization cannot preserve literal recipient interpolation syntax",
          },
        ]
      : [],
  );

  if (issues.length > 0) {
    return yield* new EmailInvalidMessage({ issues });
  }

  return undefined;
});

export const mailgunPersonalizedEmailLayer = (
  options: MailgunEmailOptions,
  policy?: EmailDeliveryPolicy,
  observer?: EmailRetryObserver,
  restriction?: EmailRetryRestriction,
): Layer.Layer<Email, EmailConfigurationError, HttpClient.HttpClient> =>
  Layer.unwrap(
    Effect.gen(function* configureMailgunPersonalization() {
      const configuration = yield* Schema.decodeEffect(MailgunConfiguration, {
        errors: "all",
        onExcessProperty: "error",
      })(options);

      const protocol = mailgunProtocol(configuration);

      const resolvedPolicy = yield* parseEmailReplayPolicy(protocol.idempotency, policy);

      return Layer.effect(
        Email,
        Effect.gen(function* acquireMailgunPersonalization() {
          const email = yield* Email;
          const client = yield* HttpClient.HttpClient;

          const request: EmailHttpPersonalizationProtocol["request"] = Effect.fnUntraced(
            function* buildNativeMailgunRequest(messages) {
              const entries: string[] = [];
              const encoder = new TextEncoder();
              let byteLength = 2;

              for (const message of messages) {
                const address = JSON.stringify(emailMailboxAddress(message.to[0]));

                const variables = JSON.stringify({
                  ...Struct.renameKeys(message.body, { html: "corven_html", text: "corven_text" }),
                  corven_subject: message.subject,
                });

                byteLength +=
                  encoder.encode(address).byteLength +
                  encoder.encode(variables).byteLength +
                  1 +
                  (entries.length === 0 ? 0 : 1);

                if (byteLength > 16 * 1024 * 1024) {
                  return yield* new EmailInvalidMessage({
                    issues: [
                      {
                        path: "body",
                        problem: "Native Mailgun recipient variables exceed 16 MiB of UTF-8 JSON",
                      },
                    ],
                  });
                }

                entries.push(`${address}:${variables}`);
              }

              return yield* protocol.request(
                { message: messages[0] },
                {
                  recipients: messages.map((message) => message.to[0]),
                  variables: `{${entries.join(",")}}`,
                },
              );
            },
          );

          const sendPersonalized = emailHttpPersonalization(
            email,
            {
              idempotency: protocol.idempotency,
              provider: protocol.provider,
              request,
              respond: protocol.respond,
              spans: { send: "Mailgun.sendPersonalized", submit: "Mailgun.submitPersonalized" },
              validate: protocol.validate,
              validateItem: validateMailgunPersonalizedItem,
            },
            client,
            resolvedPolicy,
            observer,
            restriction,
          );

          return Email.of({ ...email, personalization: "NativeAudience", sendPersonalized });
        }),
      ).pipe(
        Layer.provide(mailgunEmailLayer(configuration, resolvedPolicy, observer, restriction)),
      );
    }).pipe(
      Effect.mapError((cause) => new EmailConfigurationError({ issues: emailInputIssues(cause) })),
    ),
  );
