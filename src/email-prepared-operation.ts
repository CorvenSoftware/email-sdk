import { Array as EffectArray, Effect } from "effect";
import { emailBatchOperations } from "./email-batch.js";
import type { EmailSendError } from "./email-errors.js";
import type { EmailInvalidMessage } from "./email-invalid-message.js";
import type { EmailInvalidOptions } from "./email-invalid-options.js";
import { ownEmailMessage } from "./email-message.js";
import type { EmailMessage, EmailMessageInput, EmailReceipt } from "./email-message.js";
import { ownEmailSendOptions, prepareEmailSubmission } from "./email-preparation.js";
import type {
  EmailSendOptions,
  EmailSendOptionsInput,
  PreparedEmailSubmission,
} from "./email-preparation.js";
import type { EmailRejected } from "./email-rejected.js";
import type { EmailRouteName } from "./email-routing.js";
import { emailOperationSpan } from "./email-tracing.js";

export interface EmailPreparedPreview {
  readonly message: EmailMessage;
  readonly options: EmailSendOptions;
  readonly routes: readonly EmailRouteName[];
}

export interface EmailPreparedOperation<Receipt extends EmailReceipt = EmailReceipt> {
  readonly previews: readonly [EmailPreparedPreview, ...EmailPreparedPreview[]];
  readonly validate: Effect.Effect<void, EmailInvalidMessage | EmailInvalidOptions | EmailRejected>;
  readonly send: Effect.Effect<Receipt, EmailSendError>;
}

export const ownEmailPreparedPreviews = (
  previews: EmailPreparedOperation["previews"],
): EmailPreparedOperation["previews"] =>
  Object.freeze(
    EffectArray.map<EmailPreparedOperation["previews"], EmailPreparedPreview>((preview) =>
      Object.freeze({
        message: ownEmailMessage(preview.message),
        options: ownEmailSendOptions(preview.options),
        routes: Object.freeze([...preview.routes]),
      }),
    )(previews),
  );

export const preparedEmailOperation = <Receipt extends EmailReceipt>(
  previews: readonly [EmailPreparedPreview, ...EmailPreparedPreview[]],
  validate: EmailPreparedOperation["validate"],
  submit: Effect.Effect<Receipt, EmailSendError>,
): EmailPreparedOperation<Receipt> =>
  Object.freeze({
    previews: ownEmailPreparedPreviews(previews),
    send: submit.pipe(emailOperationSpan("EmailPreparedOperation.send")),
    validate,
  });

export const emailPreparedOperations = <Receipt extends EmailReceipt>(
  prepare: (
    submission: PreparedEmailSubmission,
  ) => Effect.Effect<
    EmailPreparedOperation<Receipt>,
    EmailInvalidMessage | EmailInvalidOptions | EmailRejected
  >,
) => {
  const prepareInput = Effect.fnUntraced(function* prepareEmailOperation(
    message: EmailMessageInput,
    options?: EmailSendOptionsInput,
  ) {
    const submission = yield* prepareEmailSubmission(message, options);

    return yield* prepare(submission);
  }, emailOperationSpan("Email.prepare"));

  const validate = Effect.fnUntraced(function* validateEmailOperation(
    message: EmailMessageInput,
    options?: EmailSendOptionsInput,
  ) {
    const operation = yield* prepareInput(message, options);

    return operation.previews[0].message;
  }, emailOperationSpan("Email.validate"));

  const send = Effect.fnUntraced(function* sendEmailOperation(
    message: EmailMessageInput,
    options?: EmailSendOptionsInput,
  ) {
    const operation = yield* prepareInput(message, options);

    return yield* operation.send;
  }, emailOperationSpan("Email.send"));

  return {
    personalization: "Individual" as const,
    ...emailBatchOperations(prepare, (operation) => operation.send),
    prepare: prepareInput,
    send,
    validate,
  };
};
