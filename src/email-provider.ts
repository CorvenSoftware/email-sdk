import { Effect, Layer, Schema } from "effect";
import type { Scope, Types } from "effect";
import type { HttpClient } from "effect/http";
import { ownEmailSenderCapabilities, validateEmailCapabilities } from "./email-capabilities.js";
import { EmailConfigurationError } from "./email-configuration-error.js";
import type { EmailDeliveryPolicy } from "./email-delivery-policy.js";
import type { EmailExtension } from "./email-extension.js";
import { emailHttpProtocolLayer } from "./email-http-protocol.js";
import type { EmailHttpExchange } from "./email-http-protocol.js";
import { emailInputIssues } from "./email-input-issues.js";
import type { EmailMessage, EmailMessageInput } from "./email-message.js";
import type { EmailSendOptionsInput } from "./email-preparation.js";
import { preflightEmailMessage } from "./email-preflight.js";
import type { EmailPreflight } from "./email-preflight.js";
import type { EmailRetryObserver, EmailRetryRestriction } from "./email-retry-decision.js";
import { ownEmailSenderIdempotency } from "./email-sender.js";
import type { EmailSender } from "./email-sender.js";
import { emailLayer } from "./email-service.js";
import type { Email } from "./email-service.js";

export {
  EmailHttpCredentialSchema,
  EmailHttpCredentialTextSchema,
} from "./email-http-credential.js";

export { readEmailHttpJson } from "./email-http-response.js";

export { parseEmailHttpRetryAfterMillis } from "./email-http-retry-after.js";

export type EmailProviderProfile = EmailPreflight;

export type { EmailHttpExchange } from "./email-http-protocol.js";

export interface EmailHttpProviderDefinition<Configuration, E = never, R = never> {
  readonly configuration: Schema.Schema<Configuration>;
  readonly profile: EmailProviderProfile;
  readonly span: string;
  readonly makeProtocol: (
    configuration: Types.NoInfer<Configuration>,
  ) => Effect.Effect<EmailHttpExchange, E, R>;
}

export interface EmailHttpProvider<Configuration, E = never, R = never> {
  readonly profile: EmailProviderProfile;
  readonly preflight: (
    message: EmailMessageInput,
    options?: EmailSendOptionsInput,
  ) => ReturnType<typeof preflightEmailMessage>;
  readonly senderLayer: (
    configuration: Configuration,
  ) => Layer.Layer<
    EmailSender,
    EmailConfigurationError | E,
    HttpClient.HttpClient | Exclude<R, Scope.Scope>
  >;
  readonly emailLayer: <EO = never, RO = never, ER = never, RR = never>(
    configuration: Configuration,
    policy?: EmailDeliveryPolicy,
    observer?: EmailExtension<EmailRetryObserver, EO, RO>,
    restriction?: EmailExtension<EmailRetryRestriction, ER, RR>,
  ) => Layer.Layer<
    Email,
    EmailConfigurationError | E | EO | ER,
    | HttpClient.HttpClient
    | Exclude<R, Scope.Scope>
    | Exclude<Exclude<RO | RR, Scope.Scope>, EmailSender>
  >;
}

export const defineEmailHttpProvider = <Configuration, E = never, R = never>(
  definition: EmailHttpProviderDefinition<Configuration, E, R>,
): EmailHttpProvider<Configuration, E, R> => {
  const { configuration: schema, makeProtocol, span } = definition;

  const capabilities = ownEmailSenderCapabilities(definition.profile.capabilities);
  const { validate } = definition.profile;

  const profile: EmailProviderProfile = Object.freeze({
    capabilities,
    idempotency: ownEmailSenderIdempotency(definition.profile.idempotency),
    provider: definition.profile.provider,
    validate: Effect.fnUntraced(function* validateProviderMessage(message: EmailMessage) {
      yield* validateEmailCapabilities(message, capabilities);
      yield* validate(message);
    }),
  });

  const senderLayer: EmailHttpProvider<Configuration, E, R>["senderLayer"] = (options) =>
    emailHttpProtocolLayer(
      Effect.gen(function* acquireEmailHttpProvider() {
        const configuration = yield* Schema.decodeEffect(Schema.toType(schema), {
          errors: "all",
          onExcessProperty: "error",
        })(options).pipe(
          Effect.mapError(
            (cause) =>
              new EmailConfigurationError({
                issues: emailInputIssues(cause).map(({ path }) => ({
                  path,
                  problem: "Invalid provider configuration",
                })),
              }),
          ),
        );

        const { request, respond } = yield* makeProtocol(configuration);

        return Object.freeze({ ...profile, request, respond, span });
      }),
    );

  const configuredEmailLayer: EmailHttpProvider<Configuration, E, R>["emailLayer"] = (
    options,
    policy,
    observer,
    restriction,
  ) => emailLayer(policy, observer, restriction).pipe(Layer.provide(senderLayer(options)));

  const preflight: EmailHttpProvider<Configuration, E, R>["preflight"] = (message, options) =>
    preflightEmailMessage(profile, message, options);

  return Object.freeze({
    emailLayer: configuredEmailLayer,
    preflight,
    profile,
    senderLayer,
  });
};
