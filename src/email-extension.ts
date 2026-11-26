import { Effect } from "effect";

export type EmailExtension<Callback, E = never, R = never> =
  | Callback
  | Effect.Effect<Callback, E, R>;

export const acquireEmailExtension = <
  Callback extends (...args: never[]) => Effect.Effect<unknown, unknown, unknown>,
  E,
  R,
>(
  extension: EmailExtension<Callback, E, R>,
): Effect.Effect<Callback, E, R> =>
  Effect.isEffect(extension) ? extension : Effect.succeed(extension);
