import { expectTypeOf } from "vitest";
import { Duration } from "effect";
import type { Layer } from "effect";
import { pacedEmailSenderLayer } from "../src/index.js";
import type {
  EmailConfigurationError,
  EmailSender,
  EmailSenderPacingOptionsInput,
} from "../src/index.js";

export const proveEmailPacingRequirements = <E, R>(
  sender: Layer.Layer<EmailSender, E, R>,
): void => {
  const options: EmailSenderPacingOptionsInput = { minimumSpacing: Duration.millis(100) };
  expectTypeOf(pacedEmailSenderLayer(sender, options)).toEqualTypeOf<
    Layer.Layer<EmailSender, E | EmailConfigurationError, R>
  >();
  // @ts-expect-error -- Pacing intervals are explicit Effect durations, not ambiguous numeric units.
  void pacedEmailSenderLayer(sender, { minimumSpacing: 100 });
  // @ts-expect-error -- Sender pacing never supplies another retry policy.
  void pacedEmailSenderLayer(sender, { ...options, maxAttempts: 3 });
};
