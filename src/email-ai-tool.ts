import { Effect, Result, Schema } from "effect";
import type { Scope, StandardSchema } from "effect";
import { EmailAgent, EmailAgentInputSchema } from "./email-agent.js";
import type { EmailAgentInput } from "./email-agent.js";
import { executeEmailAgentTool } from "./email-ai-execution.js";
import { EmailAiReceiptSchema } from "./email-ai-receipt.js";
import type { EmailAiReceipt } from "./email-ai-receipt.js";
import type { EmailAiToolError } from "./email-ai-tool-error.js";

export { EmailAiReceiptSchema } from "./email-ai-receipt.js";

export type { EmailAiReceipt } from "./email-ai-receipt.js";

export { EmailAiToolError } from "./email-ai-tool-error.js";

export type EmailAiRunner = (
  operation: Effect.Effect<EmailAiReceipt, EmailAiToolError>,
  options: { readonly signal?: AbortSignal | undefined },
) => PromiseLike<EmailAiReceipt>;

export interface EmailAiExecutionOptions {
  readonly abortSignal?: AbortSignal | undefined;
  readonly context?: unknown;
  readonly experimental_context?: unknown;
  readonly messages: readonly unknown[];
  readonly toolCallId: string;
}

export interface EmailAiTool {
  readonly description: string;
  readonly inputSchema: StandardSchema.StandardSchemaV1<EmailAgentInput> &
    StandardSchema.StandardJSONSchemaV1<EmailAgentInput>;
  readonly outputSchema: StandardSchema.StandardSchemaV1<EmailAiReceipt> &
    StandardSchema.StandardJSONSchemaV1<EmailAiReceipt>;
  readonly execute: (
    input: EmailAgentInput,
    options: EmailAiExecutionOptions,
  ) => PromiseLike<EmailAiReceipt>;
}

const parseInput = Schema.decodeUnknownResult(EmailAgentInputSchema, {
  errors: "all",
  onExcessProperty: "error",
});

const inputJsonSchema = Schema.toStandardJSONSchemaV1(Schema.Struct(EmailAgentInputSchema.fields))[
  "~standard"
].jsonSchema;

const inputSchema: EmailAiTool["inputSchema"] = {
  "~standard": {
    jsonSchema: inputJsonSchema,
    validate: (input) =>
      Result.match(parseInput(input), {
        onFailure: () => ({ issues: [{ message: "Invalid email AI tool input." }] }),
        onSuccess: (value) => ({ value }),
      }),
    vendor: "corven-email-sdk",
    version: 1,
  },
};

export const emailAiTool = Effect.fnUntraced(function* createEmailAiTool(
  run: EmailAiRunner,
): Effect.fn.Return<EmailAiTool, never, EmailAgent | Scope.Scope> {
  const agent = yield* EmailAgent;
  const scope = yield* Effect.scope;

  return {
    description:
      "Request one email with host-reviewed recipients, subject and body. Every execution requires host approval. A receipt kind is not delivery; Recorded and Simulated are not live acceptance. Never automatically retry a failed or interrupted call.",
    execute: (input, { abortSignal }): ReturnType<EmailAiRunner> =>
      run(executeEmailAgentTool(agent, input, scope), { signal: abortSignal }),
    inputSchema,
    outputSchema: Schema.toStandardJSONSchemaV1(
      Schema.toStandardSchemaV1(Schema.Struct(EmailAiReceiptSchema.fields)),
    ),
  };
});
