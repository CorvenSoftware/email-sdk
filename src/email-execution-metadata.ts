import {
  Array as EffectArray,
  DateTime,
  Effect,
  Option,
  Predicate,
  Record as EffectRecord,
  Schema,
  SchemaIssue,
  SchemaParser,
} from "effect";
import { EmailUtcInstantSchema, ownEmailUtcInstant } from "./email-message-metadata.js";

export type EmailExecutionMetadataScalar = string | number | boolean | null | undefined;

export type EmailExecutionMetadataValue =
  | EmailExecutionMetadataScalar
  | DateTime.Utc
  | readonly EmailExecutionMetadataValue[]
  | EmailExecutionMetadata;

export interface EmailExecutionMetadata {
  readonly [key: string]: EmailExecutionMetadataValue;
}

export type EmailExecutionMetadataInputValue =
  | EmailExecutionMetadataScalar
  | Date
  | DateTime.Utc
  | readonly EmailExecutionMetadataInputValue[]
  | EmailExecutionMetadataInput;

export interface EmailExecutionMetadataInput {
  readonly [key: string]: EmailExecutionMetadataInputValue;
}

const maxMetadataChildren = 32;

const maxMetadataDepth = 8;

const maxMetadataVisits = 256;

const MetadataKey = Schema.String.check(
  Schema.isPattern(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u, { expected: "an execution metadata key" }),
);

const metadataRecord = (
  value: Schema.Codec<EmailExecutionMetadataValue, EmailExecutionMetadataInputValue>,
): Schema.Codec<EmailExecutionMetadata, EmailExecutionMetadataInput> =>
  Schema.Record(MetadataKey, value).check(
    Schema.makeFilter((metadata) => Object.keys(metadata).length <= maxMetadataChildren, {
      expected: "at most 32 execution metadata entries per record",
    }),
  );

const MetadataValue: Schema.Codec<EmailExecutionMetadataValue, EmailExecutionMetadataInputValue> =
  Schema.Union([
    Schema.String.check(Schema.isMaxLength(4096)),
    Schema.Finite,
    Schema.Boolean,
    Schema.Null,
    Schema.Undefined,
    Schema.DateTimeUtcFromDate,
    EmailUtcInstantSchema,
    Schema.Array(Schema.suspend(() => MetadataValue)).check(
      Schema.isMaxLength(maxMetadataChildren),
    ),
    metadataRecord(Schema.suspend(() => MetadataValue)),
  ]);

interface MetadataInputVisit {
  readonly value: unknown;
  readonly depth: number;
  readonly target: object;
  readonly key: PropertyKey;
}

interface MetadataInputResult {
  readonly value?: unknown;
}

const isMetadataRecord = (value: unknown): value is object => {
  if (!Predicate.isObject(value)) {
    return false;
  }

  const prototype = Reflect.getPrototypeOf(value);
  const keys = Object.keys(value);

  return (
    (prototype === null || prototype === Object.prototype) &&
    keys.length <= maxMetadataChildren &&
    Reflect.ownKeys(value).length === keys.length
  );
};

const copyBoundedMetadataInput = (initial: MetadataInputVisit): boolean => {
  if (!isMetadataRecord(initial.value)) {
    return false;
  }

  const pending = [initial];
  let visited = 0;

  while (pending.length > 0) {
    const visit = pending.pop();

    if (visit === undefined) {
      break;
    }

    visited += 1;

    if (visited > maxMetadataVisits || visit.depth > maxMetadataDepth) {
      return false;
    }

    const { value } = visit;
    let owned = value;

    if (Predicate.isDate(value)) {
      const instant = DateTime.make(value);

      if (Option.isNone(instant)) {
        return false;
      }

      owned = instant.value;
    } else if (DateTime.isDateTime(value) && DateTime.isUtc(value)) {
      if (!Schema.is(EmailUtcInstantSchema)(value)) {
        return false;
      }

      owned = DateTime.toUtc(value);
    } else if (EffectArray.isArray(value)) {
      if (value.length > maxMetadataChildren) {
        return false;
      }

      const keys = Object.keys(value);

      if (
        keys.length !== value.length ||
        Reflect.ownKeys(value).length !== keys.length + 1 ||
        keys.some((key, index) => key !== String(index))
      ) {
        return false;
      }

      const array = Array.from<unknown>({ length: value.length });
      owned = array;

      for (let index = 0; index < value.length; index += 1) {
        pending.push({ depth: visit.depth + 1, key: index, target: array, value: value[index] });
      }
    } else if (Predicate.isObject(value)) {
      if (!isMetadataRecord(value)) {
        return false;
      }

      const record = {};
      owned = record;

      for (const key of Object.keys(value).toReversed()) {
        pending.push({ depth: visit.depth + 1, key, target: record, value: value[key] });
      }
    }

    Object.defineProperty(visit.target, visit.key, {
      configurable: true,
      enumerable: true,
      value: owned,
      writable: true,
    });
  }

  return true;
};

export const EmailExecutionMetadataSchema = Schema.declareConstructor<
  EmailExecutionMetadata,
  EmailExecutionMetadataInput
>()(
  [metadataRecord(MetadataValue)],
  ([record]) =>
    (input, ast, options) => {
      const owned: MetadataInputResult = {};

      if (!copyBoundedMetadataInput({ depth: 0, key: "value", target: owned, value: input })) {
        return Effect.fail(new SchemaIssue.InvalidType(ast, input, options));
      }

      return SchemaParser.decodeUnknownEffect(record)(owned.value, options);
    },
  { title: "Bounded private email execution metadata" },
);

const isDecodedMetadataRecord = Schema.is(Schema.toType(metadataRecord(MetadataValue)));

const ownExecutionMetadataValue = (
  value: EmailExecutionMetadataValue,
): EmailExecutionMetadataValue => {
  if (DateTime.isDateTime(value)) {
    return ownEmailUtcInstant(DateTime.toUtc(value));
  }

  if (EffectArray.isArray<EmailExecutionMetadataValue>(value)) {
    return Object.freeze(value.map(ownExecutionMetadataValue));
  }

  if (isDecodedMetadataRecord(value)) {
    return Object.freeze(EffectRecord.map(ownExecutionMetadataValue)(value));
  }

  return value;
};

export const ownEmailExecutionMetadata = (
  metadata: EmailExecutionMetadata,
): EmailExecutionMetadata => Object.freeze(EffectRecord.map(ownExecutionMetadataValue)(metadata));
