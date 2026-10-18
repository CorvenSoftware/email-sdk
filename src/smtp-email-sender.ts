import { isIP } from "node:net";
import { createSecureContext } from "node:tls";
import { DateTime, Duration, Effect, Layer, Match, Random, Redacted, Schema } from "effect";
import type { Scope } from "effect";
import { emailMailboxAddress } from "./email-address.js";
import {
  EmailSenderCapabilitiesSchema,
  ownEmailSenderCapabilities,
  validateEmailCapabilities,
} from "./email-capabilities.js";
import { EmailConfigurationError } from "./email-configuration-error.js";
import { EmailDeliveryUnknown } from "./email-delivery-unknown.js";
import type { EmailSubmissionError } from "./email-errors.js";
import { emailInputIssues } from "./email-input-issues.js";
import { EmailInvalidMessage } from "./email-invalid-message.js";
import { EmailReceiptSchema } from "./email-message.js";
import type { EmailMessage, EmailReceipt } from "./email-message.js";
import { emailRecipientAddresses } from "./email-recipient-outcomes.js";
import { EmailRejected } from "./email-rejected.js";
import { EmailSender, EmailSenderIdempotencySchema } from "./email-sender.js";
import type { EmailSubmission } from "./email-sender.js";
import { emailLayer } from "./email-service.js";
import type {
  Email,
  EmailDeliveryPolicy,
  EmailRetryObserver,
  EmailRetryRestriction,
} from "./email-service.js";
import { emailOperationSpan } from "./email-tracing.js";
import { renderSmtpMessage } from "./smtp-message.js";
import { connectSmtpSession } from "./smtp-session.js";
import type { SmtpConnectionOptions, SmtpReply, SmtpSession } from "./smtp-session.js";

const SmtpDomain = Schema.String.check(
  Schema.isMaxLength(253),
  Schema.isPattern(
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/u,
  ),
);

const SmtpContentId = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*@[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/u),
);

const SmtpCredential = Schema.Redacted(
  Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(128),
    Schema.isPattern(/^[\u0020-\u007E]+$/u),
  ),
);

export const SmtpAuthenticationSchema = Schema.TaggedUnion({
  Login: { password: SmtpCredential, username: SmtpCredential },
  None: {},
  Plain: { password: SmtpCredential, username: SmtpCredential },
});

const SmtpConfiguration = Schema.Struct({
  attemptTimeout: Schema.optionalKey(
    Schema.Duration.check(
      Schema.makeFilter(
        (duration) => Duration.toMillis(duration) > 0 && Duration.toMillis(duration) <= 300_000,
        { expected: "a positive SMTP attempt timeout at most five minutes" },
      ),
    ),
  ),
  authentication: SmtpAuthenticationSchema,
  certificateAuthority: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(65_536)),
  ),
  helloName: SmtpDomain,
  host: Schema.String.check(
    Schema.isMaxLength(253),
    Schema.makeFilter((host) => isIP(host) !== 0 || Schema.is(SmtpDomain)(host), {
      expected: "an explicit SMTP host",
    }),
  ),
  mailFlow: Schema.Literal("ProviderUnmodified"),
  port: Schema.Int.check(Schema.isBetween({ maximum: 65_535, minimum: 1 })),
  security: Schema.Literals(["ImplicitTls", "StartTls"]),
  serverName: Schema.optionalKey(SmtpDomain),
}).check(
  Schema.makeFilter((options) => isIP(options.host) === 0 || options.serverName !== undefined, {
    expected: "an explicit certificate server name when connecting to an IP address",
  }),
);

export type SmtpEmailOptions = typeof SmtpConfiguration.Type;

export const smtpEmailCapabilities = ownEmailSenderCapabilities(
  EmailSenderCapabilitiesSchema.make({
    attachmentContentTypes: "Explicit",
    attachments: true,
    headers: "Repeated",
    inlineAttachments: true,
    metadata: false,
    scheduling: false,
    tags: { asciiOnly: false, maxCount: 0 },
  }),
);

const validateSmtpMessage = Effect.fnUntraced(function* validateSmtpMessage(message: EmailMessage) {
  yield* validateEmailCapabilities(message, smtpEmailCapabilities);
  const addresses = emailRecipientAddresses(message);

  const issues = [
    ...(new Set(addresses.map((address) => address.toLowerCase())).size === addresses.length
      ? []
      : [{ path: "to", problem: "SMTP requires distinct recipients across all groups" }]),
    ...([message.subject, message.body.text ?? "", message.body.html ?? ""].every((text) =>
      Schema.is(Schema.String.check(Schema.isPattern(/^[^\uD800-\uDFFF]*$/u)))(text),
    )
      ? []
      : [{ path: "body", problem: "SMTP requires well-formed Unicode" }]),
    ...((message.attachments ?? []).some(
      ({ contentId, contentType }) =>
        /^(?:message|multipart)\//u.test(contentType) ||
        (contentId !== undefined && !Schema.is(SmtpContentId)(contentId)),
    )
      ? [{ path: "attachments", problem: "SMTP requires discrete MIME and qualified content IDs" }]
      : []),
    ...((message.headers ?? []).some(
      ({ name, value }) =>
        !/^[\t\u0020-\u007E]*$/u.test(value) || name.length + value.length + 2 > 998,
    )
      ? [{ path: "headers", problem: "SMTP custom headers require bounded ASCII lines" }]
      : []),
  ];

  if (issues.length > 0) {
    return yield* new EmailInvalidMessage({ issues });
  }

  return yield* Effect.void;
});

const expectSmtpReply = Effect.fnUntraced(function* expectSmtpReply(
  reply: SmtpReply,
  codes: readonly number[],
  reason: "authentication" | "rejected" = "rejected",
): Effect.fn.Return<SmtpReply, EmailSubmissionError> {
  if (codes.includes(reply.code)) {
    return reply;
  }

  if (reply.code >= 400) {
    return yield* new EmailRejected({
      provider: "smtp",
      providerCode: reply.code,
      reason: reply.code < 500 ? "temporarily-unavailable" : reason,
    });
  }

  return yield* new EmailDeliveryUnknown({
    provider: "smtp",
    providerCode: reply.code,
    reason: "unexpected-status",
  });
});

const SmtpSizeAdvertisement = Schema.String.check(Schema.isPattern(/^SIZE(?: [0-9]+)?$/iu));

const parseSmtpSizeAdvertisement = Effect.fnUntraced(function* parseSmtpSizeAdvertisement(
  hello: SmtpReply,
): Effect.fn.Return<bigint | undefined, EmailDeliveryUnknown> {
  const advertisements = hello.lines
    .slice(1)
    .filter((line) => /^SIZE(?:[^A-Za-z0-9-]|$)/iu.test(line));

  if (advertisements.length === 0) {
    return undefined;
  }

  const [advertisement] = advertisements;

  if (advertisements.length !== 1 || advertisement === undefined) {
    return yield* new EmailDeliveryUnknown({ provider: "smtp", reason: "invalid-response" });
  }

  const selected = yield* Schema.decodeEffect(SmtpSizeAdvertisement)(advertisement).pipe(
    Effect.mapError(
      () => new EmailDeliveryUnknown({ provider: "smtp", reason: "invalid-response" }),
    ),
  );

  return BigInt(selected.slice(5) || "0");
});

const smtpAuthenticationMechanisms = (reply: SmtpReply) =>
  new Set(
    reply.lines
      .slice(1)
      .filter((line) => /^AUTH /iu.test(line))
      .flatMap((line) => line.toUpperCase().split(/ +/u).slice(1)),
  );

const authenticateSmtp = (
  session: SmtpSession,
  authentication: typeof SmtpAuthenticationSchema.Type,
  hello: SmtpReply,
) => {
  const mechanisms = smtpAuthenticationMechanisms(hello);

  const challenge = Effect.fnUntraced(function* smtpAuthenticationChallenge(command: string) {
    const reply = yield* session.exchange(command);
    yield* expectSmtpReply(reply, [334], "authentication");

    if (
      reply.lines.length !== 1 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
        reply.lines.join(""),
      )
    ) {
      return yield* new EmailDeliveryUnknown({ provider: "smtp", reason: "invalid-response" });
    }

    return reply;
  });

  const requireMechanism = (name: "PLAIN" | "LOGIN") =>
    mechanisms.has(name)
      ? Effect.void
      : Effect.fail(new EmailRejected({ provider: "smtp", reason: "authentication" }));

  return Match.value(authentication).pipe(
    Match.tag("None", () => Effect.void),
    Match.tag("Plain", (credentials) =>
      Effect.gen(function* smtpPlainAuthentication() {
        yield* requireMechanism("PLAIN");
        const reply = yield* challenge("AUTH PLAIN\r\n");

        if (reply.lines.join("") !== "") {
          return yield* new EmailDeliveryUnknown({ provider: "smtp", reason: "invalid-response" });
        }

        const encoded = Buffer.from(
          `\0${Redacted.value(credentials.username)}\0${Redacted.value(credentials.password)}`,
          "utf-8",
        ).toString("base64");

        yield* session
          .exchange(`${encoded}\r\n`)
          .pipe(Effect.flatMap((response) => expectSmtpReply(response, [235], "authentication")));

        return yield* Effect.void;
      }),
    ),
    Match.tag("Login", (credentials) =>
      Effect.gen(function* smtpLoginAuthentication() {
        yield* requireMechanism("LOGIN");
        yield* challenge("AUTH LOGIN\r\n");
        yield* challenge(
          `${Buffer.from(Redacted.value(credentials.username), "utf-8").toString("base64")}\r\n`,
        );
        yield* session
          .exchange(
            `${Buffer.from(Redacted.value(credentials.password), "utf-8").toString("base64")}\r\n`,
          )
          .pipe(Effect.flatMap((response) => expectSmtpReply(response, [235], "authentication")));
      }),
    ),
    Match.exhaustive,
  );
};

const establishSmtpSession = Effect.fnUntraced(function* establishSmtpSession(
  options: SmtpConnectionOptions,
  helloName: string,
): Effect.fn.Return<readonly [SmtpSession, SmtpReply], EmailSubmissionError, Scope.Scope> {
  const session = yield* connectSmtpSession(options);
  yield* session.exchange().pipe(Effect.flatMap((reply) => expectSmtpReply(reply, [220])));

  const hello = yield* session
    .exchange(`EHLO ${helloName}\r\n`)
    .pipe(Effect.flatMap((reply) => expectSmtpReply(reply, [250])));

  if (options.security === "ImplicitTls") {
    return [session, hello];
  }

  if (!hello.lines.slice(1).some((line) => line.toUpperCase() === "STARTTLS")) {
    return yield* new EmailRejected({ provider: "smtp", reason: "authentication" });
  }

  yield* session
    .exchange("STARTTLS\r\n")
    .pipe(Effect.flatMap((reply) => expectSmtpReply(reply, [220], "authentication")));
  const secure = yield* connectSmtpSession(options, session.socket);

  const secureHello = yield* secure
    .exchange(`EHLO ${helloName}\r\n`)
    .pipe(Effect.flatMap((reply) => expectSmtpReply(reply, [250])));

  return [secure, secureHello];
});

const submitSmtpMessage = Effect.fnUntraced(function* submitSmtpMessage(
  session: SmtpSession,
  message: EmailMessage,
  helloName: string,
  maximum: bigint | undefined,
): Effect.fn.Return<EmailReceipt, EmailSubmissionError> {
  const date = yield* DateTime.nowAsDate;
  const first = yield* Random.nextInt;
  const second = yield* Random.nextInt;

  const rendered = renderSmtpMessage(message, {
    date: date.toUTCString().replace("GMT", "+0000"),
    messageId: `${first.toString(36)}.${second.toString(36)}@${helloName}`,
  });

  if (maximum !== undefined && maximum > 0n && BigInt(rendered.size) > maximum) {
    return yield* new EmailRejected({ provider: "smtp", reason: "rejected" });
  }

  const sizeParameter = maximum === undefined ? "" : ` SIZE=${rendered.size}`;

  yield* session
    .exchange(`MAIL FROM:<${emailMailboxAddress(message.from)}>${sizeParameter}\r\n`)
    .pipe(Effect.flatMap((reply) => expectSmtpReply(reply, [250])));
  const accepted = [];
  const rejected = [];

  for (const recipient of emailRecipientAddresses(message)) {
    const reply = yield* session.exchange(`RCPT TO:<${recipient}>\r\n`);

    if (reply.code === 421) {
      return yield* new EmailRejected({
        provider: "smtp",
        providerCode: 421,
        reason: "temporarily-unavailable",
      });
    }

    if (reply.code >= 400) {
      rejected.push(recipient);
    } else {
      yield* expectSmtpReply(reply, [250, 251]);
      accepted.push(recipient);
    }
  }

  if (accepted.length === 0) {
    const recipients = yield* Schema.decodeUnknownEffect(
      EmailReceiptSchema.cases.RecipientsRejected.fields.rejected,
    )(rejected).pipe(
      Effect.mapError(
        () => new EmailDeliveryUnknown({ provider: "smtp", reason: "invalid-response" }),
      ),
    );

    const receipt = EmailReceiptSchema.cases.RecipientsRejected.make({
      provider: "smtp",
      rejected: recipients,
    });

    Object.freeze(receipt.rejected);

    return Object.freeze(receipt);
  }

  yield* session
    .exchange("DATA\r\n")
    .pipe(Effect.flatMap((reply) => expectSmtpReply(reply, [354])));
  yield* session
    .exchange(rendered.data)
    .pipe(Effect.flatMap((reply) => expectSmtpReply(reply, [250])));

  if (rejected.length === 0) {
    return Object.freeze(EmailReceiptSchema.cases.Accepted.make({ provider: "smtp" }));
  }

  const partition = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      accepted: EmailReceiptSchema.cases.PartiallyRejected.fields.accepted,
      rejected: EmailReceiptSchema.cases.PartiallyRejected.fields.rejected,
    }),
  )({ accepted, rejected }).pipe(
    Effect.mapError(
      () => new EmailDeliveryUnknown({ provider: "smtp", reason: "invalid-response" }),
    ),
  );

  const receipt = EmailReceiptSchema.cases.PartiallyRejected.make({
    ...partition,
    provider: "smtp",
  });

  Object.freeze(receipt.accepted);
  Object.freeze(receipt.rejected);

  return Object.freeze(receipt);
});

export const smtpSenderLayer = (
  options: SmtpEmailOptions,
): Layer.Layer<EmailSender, EmailConfigurationError> =>
  Layer.effect(
    EmailSender,
    Effect.gen(function* acquireSmtpSender() {
      const configuration = yield* Schema.decodeEffect(Schema.toType(SmtpConfiguration), {
        errors: "all",
        onExcessProperty: "error",
      })(options).pipe(
        Effect.mapError(
          (cause) => new EmailConfigurationError({ issues: emailInputIssues(cause) }),
        ),
      );

      const secureContext = yield* Effect.try({
        catch: () =>
          new EmailConfigurationError({
            issues: [{ path: "certificateAuthority", problem: "Invalid SMTP TLS configuration" }],
          }),
        try: () =>
          createSecureContext({
            ca: configuration.certificateAuthority,
            minVersion: "TLSv1.2",
          }),
      });

      const connection: SmtpConnectionOptions = {
        host: configuration.host,
        port: configuration.port,
        secureContext,
        security: configuration.security,
        serverName: configuration.serverName ?? configuration.host,
      };

      const timeout =
        configuration.attemptTimeout === undefined
          ? 30_000
          : Duration.toMillis(configuration.attemptTimeout);

      const authentication = Object.freeze({ ...configuration.authentication });
      const { helloName } = configuration;

      const submit = Effect.fnUntraced(
        function* submitSmtp(
          submission: EmailSubmission,
        ): Effect.fn.Return<EmailReceipt, EmailSubmissionError, Scope.Scope> {
          if (submission.idempotencyKey !== undefined) {
            return yield* new EmailRejected({
              provider: "smtp",
              reason: "unsupported-idempotency",
            });
          }

          yield* validateSmtpMessage(submission.message).pipe(
            Effect.mapError(
              () => new EmailRejected({ provider: "smtp", reason: "invalid-message" }),
            ),
          );
          const [session, hello] = yield* establishSmtpSession(connection, helloName);
          const maximum = yield* parseSmtpSizeAdvertisement(hello);
          yield* authenticateSmtp(session, authentication, hello);

          return yield* submitSmtpMessage(session, submission.message, helloName, maximum);
        },
        Effect.scoped,
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () =>
            Effect.fail(new EmailDeliveryUnknown({ provider: "smtp", reason: "timeout" })),
        }),
        emailOperationSpan("SmtpEmailSender.submit"),
      );

      return EmailSender.of({
        capabilities: smtpEmailCapabilities,
        idempotency: Object.freeze(EmailSenderIdempotencySchema.cases.None.make({})),
        provider: "smtp",
        submit,
        validate: validateSmtpMessage,
      });
    }),
  );

export const smtpEmailLayer = (
  options: SmtpEmailOptions,
  policy?: EmailDeliveryPolicy,
  observer?: EmailRetryObserver,
  restriction?: EmailRetryRestriction,
): Layer.Layer<Email, EmailConfigurationError> =>
  emailLayer(policy, observer, restriction).pipe(Layer.provide(smtpSenderLayer(options)));
