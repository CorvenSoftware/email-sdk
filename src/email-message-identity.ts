import { Array as EffectArray, Effect, Predicate, Schema } from "effect";
import { EmailMessageSchema } from "./email-message.js";
import type { EmailMessage } from "./email-message.js";

const encodeEmailMessageJson = Schema.encodeEffect(Schema.toCodecJson(EmailMessageSchema));

const canonicalEmailJson = (value: Schema.Json): Schema.Json => {
  if (
    value === null ||
    Predicate.isString(value) ||
    Predicate.isNumber(value) ||
    Predicate.isBoolean(value)
  ) {
    return value;
  }

  if (EffectArray.isArray<Schema.Json>(value)) {
    return value.map(canonicalEmailJson);
  }

  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([left], [right]) => {
        if (left === right) {
          return 0;
        }

        return left < right ? -1 : 1;
      })
      .map(([key, entry]) => [key, canonicalEmailJson(entry)]),
  );
};

export const canonicalEmailMessageIdentity = (
  message: EmailMessage,
): Effect.Effect<string, Schema.SchemaError> =>
  encodeEmailMessageJson(message).pipe(
    Effect.map((encoded) => JSON.stringify(canonicalEmailJson(encoded))),
  );
