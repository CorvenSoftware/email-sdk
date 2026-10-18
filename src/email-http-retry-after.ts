import { Option, Schema } from "effect";

const decodeEmailRetryAfterSeconds = Schema.decodeUnknownOption(
  Schema.NumberFromString.check(
    Schema.isFinite(),
    Schema.isBetween({ maximum: 86_400, minimum: 0 }),
  ),
);

export const parseEmailHttpRetryAfterMillis = (header: string | undefined) =>
  decodeEmailRetryAfterSeconds(header).pipe(Option.map((seconds) => seconds * 1000));
