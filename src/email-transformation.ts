import { Effect, Layer } from "effect";
import type { Scope } from "effect";
import { acquireEmailExtension } from "./email-extension.js";
import type { EmailExtension } from "./email-extension.js";
import { requireIndividualEmailPreparation } from "./email-composition.js";
import type { EmailConfigurationError } from "./email-configuration-error.js";
import type { EmailInvalidMessage } from "./email-invalid-message.js";
import type { EmailMessageInput } from "./email-message.js";
import { emailPreparedOperations } from "./email-prepared-operation.js";
import type { EmailPreparedPreview } from "./email-prepared-operation.js";
import { preparedEmailSendOptions } from "./email-preparation.js";
import type { PreparedEmailSubmission } from "./email-preparation.js";
import { Email } from "./email-service.js";
import { emailOperationSpan } from "./email-tracing.js";

export type EmailMessageTransformInput = Pick<EmailPreparedPreview, "message" | "options">;

export type EmailMessageTransform = (
  input: EmailMessageTransformInput,
) => Effect.Effect<EmailMessageInput, EmailInvalidMessage>;

export const transformedEmailLayer = <E, R, E2 = never, R2 = never>(
  emailLayer: Layer.Layer<Email, E, R>,
  transform: EmailExtension<EmailMessageTransform, E2, R2>,
): Layer.Layer<
  Email,
  E | E2 | EmailConfigurationError,
  R | Exclude<Exclude<R2, Scope.Scope>, Email>
> =>
  Layer.effect(
    Email,
    Effect.gen(function* acquireTransformedEmail() {
      const email = yield* Email;
      yield* requireIndividualEmailPreparation(email.personalization);
      const transformMessage = yield* acquireEmailExtension(transform);

      const prepare = Effect.fnUntraced(function* prepareTransformedEmail(
        prepared: PreparedEmailSubmission,
      ) {
        const options = preparedEmailSendOptions(prepared);

        const message = yield* transformMessage(
          Object.freeze({ message: prepared.submission.message, options }),
        );

        return yield* email.prepare(message, options);
      }, emailOperationSpan("Email.transform"));

      return Email.of({ capabilities: email.capabilities, ...emailPreparedOperations(prepare) });
    }),
  ).pipe(Layer.provide(emailLayer));
