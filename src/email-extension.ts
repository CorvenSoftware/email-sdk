import { Effect } from "effect";
import type { EmailMessageTransform } from "./email-transformation.js";
import type { EmailOperationObserver } from "./email-operation-observations.js";
import type { EmailRetryObserver, EmailRetryRestriction } from "./email-retry-decision.js";
import type {
  EmailSubmissionObserver,
  EmailSubmissionStartingObserver,
} from "./email-submission-observations.js";
import type {
  EmailNativeObserver,
  EmailNativeStartingObserver,
} from "./email-native-observations.js";

type EmailExtensionCallback =
  | EmailMessageTransform
  | EmailOperationObserver
  | EmailRetryObserver
  | EmailRetryRestriction
  | EmailSubmissionObserver
  | EmailSubmissionStartingObserver
  | EmailNativeObserver
  | EmailNativeStartingObserver;

export type EmailExtension<Callback, E = never, R = never> =
  | Callback
  | Effect.Effect<Callback, E, R>;

export const acquireEmailExtension = <Callback extends EmailExtensionCallback, E, R>(
  extension: EmailExtension<Callback, E, R>,
): Effect.Effect<Callback, E, R> =>
  Effect.isEffect(extension) ? extension : Effect.succeed(extension);
