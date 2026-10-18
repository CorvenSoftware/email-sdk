import { Effect, Schema, Stream } from "effect";
import type { HttpClientResponse } from "effect/http";
import { EmailDeliveryUnknown } from "./email-delivery-unknown.js";

export const readEmailHttpJson = (
  response: HttpClientResponse.HttpClientResponse,
  provider: string,
): Effect.Effect<Schema.Json, EmailDeliveryUnknown> =>
  response.stream.pipe(
    Stream.mapAccumEffect(
      () => 0,
      (size, chunk) => {
        const nextSize = size + chunk.byteLength;

        return nextSize <= 64 * 1024
          ? Effect.succeed([nextSize, [chunk]] as const)
          : Effect.fail(
              new EmailDeliveryUnknown({
                provider,
                reason: "invalid-response",
                status: response.status,
              }),
            );
      },
    ),
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (body, chunk) => body + chunk,
    ),
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Schema.Json))),
    Effect.mapError(
      () =>
        new EmailDeliveryUnknown({ provider, reason: "invalid-response", status: response.status }),
    ),
  );
