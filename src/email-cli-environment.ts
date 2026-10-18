import { Context } from "effect";
import type { Effect } from "effect";
import type { EmailCliError } from "./email-cli-error.js";

export const maxEmailCliInputBytes = 33_554_432;

export interface IEmailCliEnvironment {
  readonly readRequest: Effect.Effect<string, EmailCliError>;
  readonly readDistribution: Effect.Effect<string, EmailCliError>;
}

export class EmailCliEnvironment extends Context.Service<
  EmailCliEnvironment,
  IEmailCliEnvironment
>()("@corven/email-sdk/EmailCliEnvironment") {}
