import { Schema } from "effect";

export const EmailRetryAfterMillisSchema = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
