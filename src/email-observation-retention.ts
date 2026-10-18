import { Schema } from "effect";

export const EmailObservationOptionsSchema = Schema.Struct({
  capacity: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ maximum: 10_000, minimum: 1 }))),
});

export type EmailObservationOptions = typeof EmailObservationOptionsSchema.Encoded;

export interface EmailObservationSnapshot<Observation> {
  readonly observations: readonly Observation[];
  readonly truncated: boolean;
}

export const appendEmailObservation = <Observation>(
  current: EmailObservationSnapshot<Observation>,
  observation: Observation,
  capacity: number,
): EmailObservationSnapshot<Observation> =>
  Object.freeze({
    observations: Object.freeze([...current.observations, observation].slice(-capacity)),
    truncated: current.truncated || current.observations.length >= capacity,
  });
