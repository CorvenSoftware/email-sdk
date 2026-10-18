import { Effect, Schema } from "effect";
import { EmailAddressSchema, emailMailboxAddress } from "./email-address.js";
import type { EmailAddress } from "./email-address.js";
import { EmailDeliveryUnknown } from "./email-delivery-unknown.js";
import type { EmailMessage } from "./email-message.js";

export const EmailRecipientCountsSchema = Schema.Struct({
  acceptedCount: Schema.Int.check(Schema.isBetween({ maximum: 50, minimum: 0 })),
  rejectedCount: Schema.Int.check(Schema.isBetween({ maximum: 50, minimum: 0 })),
}).check(
  Schema.makeFilter((counts) => counts.acceptedCount + counts.rejectedCount <= 50, {
    expected: "at most 50 counted recipients",
  }),
);

export type EmailRecipientCounts = typeof EmailRecipientCountsSchema.Type;

export const emailRecipientAddresses = (message: EmailMessage): readonly EmailAddress[] =>
  Object.freeze(
    [...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])].map(emailMailboxAddress),
  );

export const parseEmailRecipientCounts = Effect.fnUntraced(function* parseEmailRecipientCounts(
  message: EmailMessage,
  input: EmailRecipientCounts,
  provider: string,
  status: number,
): Effect.fn.Return<EmailRecipientCounts, EmailDeliveryUnknown> {
  const invalid = () => new EmailDeliveryUnknown({ provider, reason: "invalid-response", status });

  const counts = yield* Schema.decodeEffect(EmailRecipientCountsSchema)(input).pipe(
    Effect.mapError(invalid),
  );

  const requested = emailRecipientAddresses(message);

  if (
    counts.acceptedCount + counts.rejectedCount !== requested.length ||
    new Set(requested.map((address) => address.toLowerCase())).size !== requested.length
  ) {
    return yield* invalid();
  }

  return Object.freeze(counts);
});

export const parseEmailRecipientCoverage = Effect.fnUntraced(function* parseEmailRecipientCoverage(
  message: EmailMessage,
  addresses: readonly EmailAddress[],
  provider: string,
  status: number,
): Effect.fn.Return<void, EmailDeliveryUnknown> {
  const invalid = () => new EmailDeliveryUnknown({ provider, reason: "invalid-response", status });

  const observed = yield* Schema.decodeEffect(
    Schema.Array(EmailAddressSchema).check(Schema.isMaxLength(50)),
  )(addresses).pipe(Effect.mapError(invalid));

  const requested = emailRecipientAddresses(message).map((address) => address.toLowerCase());
  const members = observed.map((address) => address.toLowerCase());

  if (
    members.length !== requested.length ||
    new Set(requested).size !== requested.length ||
    new Set(members).size !== members.length ||
    members.some((address) => !requested.includes(address))
  ) {
    return yield* invalid();
  }

  return undefined;
});

const EmailSuppressionPartition = Schema.Struct({
  accepted: Schema.Array(EmailAddressSchema),
  suppressed: Schema.NonEmptyArray(EmailAddressSchema),
});

export const partitionEmailSuppressions = Effect.fnUntraced(function* partitionEmailSuppressions(
  message: EmailMessage,
  addresses: readonly EmailAddress[],
  provider: string,
  status: number,
): Effect.fn.Return<typeof EmailSuppressionPartition.Type, EmailDeliveryUnknown> {
  const invalid = () => new EmailDeliveryUnknown({ provider, reason: "invalid-response", status });

  const requested = emailRecipientAddresses(message);

  const requestedSet = new Set(requested.map((address) => address.toLowerCase()));
  const suppressedSet = new Set(addresses.map((address) => address.toLowerCase()));

  if (
    requestedSet.size !== requested.length ||
    suppressedSet.size !== addresses.length ||
    addresses.some((address) => !requestedSet.has(address.toLowerCase()))
  ) {
    return yield* invalid();
  }

  const partition = yield* Schema.decodeUnknownEffect(EmailSuppressionPartition)({
    accepted: requested.filter((address) => !suppressedSet.has(address.toLowerCase())),
    suppressed: requested.filter((address) => suppressedSet.has(address.toLowerCase())),
  }).pipe(Effect.mapError(invalid));

  Object.freeze(partition.accepted);
  Object.freeze(partition.suppressed);

  return Object.freeze(partition);
});
