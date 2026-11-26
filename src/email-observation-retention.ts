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
): EmailObservationSnapshot<Observation> => {
  const observations = current.observations.slice(
    Math.max(0, current.observations.length - capacity + 1),
  );

  observations.push(observation);

  return Object.freeze({
    observations: Object.freeze(observations),
    truncated: current.truncated || current.observations.length >= capacity,
  });
};
