import { Effect, Layer } from "effect";
import type { Result, Scope } from "effect";
import { expectTypeOf } from "vitest";
import {
  Email,
  EmailRouter,
  EmailSender,
  emailLayer,
  emailLayerFromSender,
  explainEmailRoutePlan,
} from "../src/index.js";
import type {
  EmailConfigurationError,
  EmailInvalidMessage,
  EmailInvalidOptions,
  EmailMessage,
  EmailPreparedOperation,
  EmailReceipt,
  EmailRejected,
  EmailRoutePlanExplanation,
  EmailSendError,
  EmailSenderCapabilities,
  IEmailRoute,
  IEmailRouter,
} from "../src/index.js";
import type { EmailExtension } from "../src/email-extension.js";
import type { EmailRetryObserver, EmailRetryRestriction } from "../src/email-retry-decision.js";

const message = {
  body: { text: "Fictional typed example." },
  from: "sender@example.test",
  subject: "Typed email operations",
  to: "recipient@example.test",
};

const send = Email.send(message);

expectTypeOf(send).toEqualTypeOf<Effect.Effect<EmailReceipt, EmailSendError, Email>>();

expectTypeOf(send).not.toExtend<Effect.Effect<EmailReceipt, EmailSendError>>();

expectTypeOf(Email.prepare(message)).toEqualTypeOf<
  Effect.Effect<
    EmailPreparedOperation,
    EmailInvalidMessage | EmailInvalidOptions | EmailRejected,
    Email
  >
>();

expectTypeOf(Email.validate(message)).toEqualTypeOf<
  Effect.Effect<EmailMessage, EmailInvalidMessage | EmailInvalidOptions | EmailRejected, Email>
>();

expectTypeOf(Email.sendAll([{ message }])).toEqualTypeOf<
  Effect.Effect<readonly Result.Result<EmailReceipt, EmailSendError>[], EmailInvalidOptions, Email>
>();

expectTypeOf(
  Email.sendPersonalized({
    message: { body: message.body, from: message.from, subject: message.subject },
    recipients: [{ to: message.to, variables: {} }],
  }),
).toEqualTypeOf<
  Effect.Effect<
    readonly Result.Result<EmailReceipt, EmailSendError>[],
    EmailInvalidMessage | EmailInvalidOptions,
    Email
  >
>();

expectTypeOf(Email.capabilities).toEqualTypeOf<
  Effect.Effect<EmailSenderCapabilities, never, Email>
>();

expectTypeOf(Email.personalization).toEqualTypeOf<
  Effect.Effect<"Individual" | "NativeAudience", never, Email>
>();

expectTypeOf(EmailRouter.routes).toEqualTypeOf<
  Effect.Effect<IEmailRouter["routes"], never, EmailRouter>
>();

expectTypeOf(EmailRouter.select()).toEqualTypeOf<
  Effect.Effect<IEmailRoute, EmailInvalidOptions, EmailRouter>
>();

expectTypeOf(explainEmailRoutePlan({ primary: "primary" }, { message })).toEqualTypeOf<
  Effect.Effect<EmailRoutePlanExplanation, EmailInvalidMessage | EmailInvalidOptions, EmailRouter>
>();

export const proveEmailLayerRequirements = <E, R, EO, RO, ER, RR>(
  sender: Layer.Layer<EmailSender, E, R>,
  observer: EmailExtension<EmailRetryObserver, EO, RO>,
  restriction: EmailExtension<EmailRetryRestriction, ER, RR>,
): void => {
  const account = emailLayerFromSender(sender);
  const existing = emailLayer().pipe(Layer.provide(sender));
  expectTypeOf(account).toEqualTypeOf<typeof existing>();
  expectTypeOf(account).toEqualTypeOf<Layer.Layer<Email, E | EmailConfigurationError, R>>();
  expectTypeOf(send.pipe(Effect.provide(account))).toEqualTypeOf<
    Effect.Effect<EmailReceipt, EmailSendError | EmailConfigurationError | E, R>
  >();
  const observed = emailLayerFromSender(sender, undefined, observer, restriction);
  expectTypeOf(observed).toEqualTypeOf<
    Layer.Layer<
      Email,
      E | EmailConfigurationError | EO | ER,
      | R
      | Exclude<Exclude<RO, Scope.Scope>, EmailSender>
      | Exclude<Exclude<RR, Scope.Scope>, EmailSender>
    >
  >();
  const senderObserver = EmailSender.pipe(Effect.map(() => (): Effect.Effect<void> => Effect.void));
  expectTypeOf(emailLayerFromSender(sender, undefined, senderObserver)).toEqualTypeOf<
    Layer.Layer<Email, E | EmailConfigurationError, R>
  >();
};

export const proveEmailAccessorFailures = (): void => {
  // @ts-expect-error -- Recipient input remains typed at direct call sites.
  void Email.send({ ...message, to: 123 });
  // @ts-expect-error -- The sender implementation must be supplied explicitly.
  void emailLayerFromSender<never, never>();
  // @ts-expect-error -- Route plan names remain strings, not numeric selectors.
  void EmailRouter.select({ primary: 123 });
  // @ts-expect-error -- Routing diagnostics require an explicit plan and request envelope.
  void explainEmailRoutePlan({ primary: "primary" }, message);
};
