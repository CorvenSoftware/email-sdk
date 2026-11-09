import { Effect } from "effect";
import { HttpClient } from "effect/http";
import type { HttpClientRequest, HttpClientResponse } from "effect/http";
import { EmailDeliveryUnknown } from "./email-delivery-unknown.js";
import { protectEmailUnsettledCause } from "./email-unsettled-cause.js";

export const executeEmailHttpRequest = <E, R>(
  client: HttpClient.HttpClient.With<E, R>,
  request: HttpClientRequest.HttpClientRequest,
  provider: string,
): Effect.Effect<HttpClientResponse.HttpClientResponse, EmailDeliveryUnknown, R> =>
  client.execute(request).pipe(
    Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
    protectEmailUnsettledCause,
    Effect.mapError(() => new EmailDeliveryUnknown({ provider, reason: "transport" })),
  );
