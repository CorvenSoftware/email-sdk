import { Effect, Schema } from "effect";
import type { Result } from "effect";
import type { EmailSendError } from "./email-errors.js";
import { ownEmailDeliveryPolicy } from "./email-delivery-policy.js";
import { emailInputIssues } from "./email-input-issues.js";
import { EmailInvalidMessage } from "./email-invalid-message.js";
import { EmailInvalidOptions } from "./email-invalid-options.js";
import type { EmailReceipt } from "./email-message.js";
import {
  EmailPolicyOptionsSchema as EmailSendOptionsSchema,
  parseEmailBatchOptions,
  qualifyEmailRequestFailure,
} from "./email-preparation.js";
import type {
  EmailBatchOptionsInput,
  EmailPolicyOptionsInput as EmailSendOptionsInput,
} from "./email-preparation.js";
import type { EmailRejected } from "./email-rejected.js";
import { submitPreparedEmailBatch } from "./email-settled-batch.js";
import { protectEmailUnsettledCause } from "./email-unsettled-cause.js";
import { emailOperationSpan } from "./email-tracing.js";

export interface EmailNativeRequest<Input> {
  readonly job: Input;
  readonly options?: EmailSendOptionsInput;
}

export interface EmailNativeOperations<Job, Input> {
  readonly validate: (
    input: Input,
    options?: EmailSendOptionsInput,
  ) => Effect.Effect<Job, EmailInvalidMessage | EmailInvalidOptions | EmailRejected>;
  readonly send: (
    input: Input,
    options?: EmailSendOptionsInput,
  ) => Effect.Effect<EmailReceipt, EmailSendError>;
  readonly sendAll: (
    requests: readonly EmailNativeRequest<Input>[],
    options?: EmailBatchOptionsInput,
  ) => Effect.Effect<readonly Result.Result<EmailReceipt, EmailSendError>[], EmailInvalidOptions>;
}

export const prepareEmailNativeOperation = Effect.fnUntraced(function* prepareEmailNativeOperation<
  Input,
  Job extends Input,
>(
  native: EmailNativeOperations<Job, Input>,
  ownJob: (job: Job) => Job,
  job: Job,
  options: typeof EmailSendOptionsSchema.Type,
) {
  const ownedJob = ownJob(job);
  const ownedOptions = { ...options };

  if (options.policy !== undefined) {
    ownedOptions.policy = ownEmailDeliveryPolicy(options.policy);
  }

  Object.freeze(ownedOptions);
  const preview = yield* native.validate(ownedJob, ownedOptions);

  return Object.freeze({ job: ownedJob, options: ownedOptions, preview });
});

export const emailNativeOperations = <Job, Input, Prepared>(configuration: {
  readonly jobSchema: Schema.Codec<Job, Input>;
  readonly jobOf: (prepared: Prepared) => Job;
  readonly prepare: (
    job: Job,
    options: typeof EmailSendOptionsSchema.Type,
  ) => Effect.Effect<Prepared, EmailInvalidMessage | EmailInvalidOptions | EmailRejected>;
  readonly spans: { readonly validate: string; readonly send: string; readonly sendAll: string };
  readonly submit: (prepared: Prepared) => Effect.Effect<EmailReceipt, EmailSendError>;
}): EmailNativeOperations<Job, Input> => {
  const requestSchema = Schema.Struct({
    job: configuration.jobSchema,
    options: Schema.optionalKey(EmailSendOptionsSchema),
  });

  const prepare = Effect.fnUntraced(function* prepareNativeEmailSubmission(
    input: Input,
    options: EmailSendOptionsInput = {},
  ) {
    const job = yield* Schema.decodeEffect(configuration.jobSchema, {
      errors: "all",
      onExcessProperty: "error",
    })(input).pipe(
      Effect.mapError((cause) => new EmailInvalidMessage({ issues: emailInputIssues(cause) })),
    );

    const parsedOptions = yield* Schema.decodeEffect(EmailSendOptionsSchema, {
      errors: "all",
      onExcessProperty: "error",
    })(options).pipe(
      Effect.mapError((cause) => new EmailInvalidOptions({ issues: emailInputIssues(cause) })),
    );

    return yield* configuration.prepare(job, parsedOptions);
  });

  const prepareRequest = Effect.fnUntraced(function* prepareNativeEmailRequest(
    request: EmailNativeRequest<Input>,
  ) {
    const parsed = yield* Schema.decodeEffect(requestSchema, {
      errors: "all",
      onExcessProperty: "error",
    })(request).pipe(
      Effect.mapError((cause) => {
        const issues = emailInputIssues(cause);

        return issues.some((issue) => issue.path === "job" || issue.path.startsWith("job."))
          ? new EmailInvalidMessage({ issues })
          : new EmailInvalidOptions({ issues });
      }),
    );

    return yield* qualifyEmailRequestFailure(
      configuration.prepare(parsed.job, parsed.options ?? {}),
      "job",
    );
  });

  const validate = Effect.fnUntraced(function* validateNativeEmailJob(
    input: Input,
    options?: EmailSendOptionsInput,
  ) {
    return configuration.jobOf(yield* prepare(input, options));
  }, emailOperationSpan(configuration.spans.validate));

  const send = Effect.fnUntraced(function* sendNativeEmailJob(
    input: Input,
    options?: EmailSendOptionsInput,
  ) {
    return yield* configuration.submit(yield* prepare(input, options));
  }, emailOperationSpan(configuration.spans.send));

  const sendAll = Effect.fnUntraced(function* sendAllNativeEmailJobs(
    requests: readonly EmailNativeRequest<Input>[],
    options?: EmailBatchOptionsInput,
  ) {
    const parsedOptions = yield* parseEmailBatchOptions(options);

    const prepared = yield* Effect.forEach(
      requests,
      (request) => prepareRequest(request).pipe(protectEmailUnsettledCause, Effect.result),
      { concurrency: 1 },
    );

    return yield* submitPreparedEmailBatch(
      prepared,
      parsedOptions.concurrency,
      configuration.submit,
    );
  }, emailOperationSpan(configuration.spans.sendAll));

  return { send, sendAll, validate };
};
