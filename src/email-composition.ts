import { Effect, Schema } from "effect";
import { EmailConfigurationError } from "./email-configuration-error.js";

export const EmailPersonalizationModeSchema = Schema.Literals(["Individual", "NativeAudience"]);

export type EmailPersonalizationMode = typeof EmailPersonalizationModeSchema.Type;

export const requireIndividualEmailPreparation = (
  personalization: EmailPersonalizationMode,
): Effect.Effect<void, EmailConfigurationError> =>
  personalization === "Individual"
    ? Effect.void
    : Effect.fail(
        new EmailConfigurationError({
          issues: [
            {
              path: "personalization",
              problem:
                "Native audience execution does not support individual preparation composition",
            },
          ],
        }),
      );
