import { createServer } from "node:http";
import type { Server } from "node:http";
import { assert } from "vitest";
import { Effect, Layer, Option, Predicate, Queue, Schema } from "effect";
import type { Scope } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

export interface ReceivedEmailHttpSubmission {
  readonly authorization: string;
  readonly host: string;
  readonly sesSigningHost: string;
  readonly sesDate: string;
  readonly sesPayloadHash: string;
  readonly sesSessionToken: string;
  readonly apiToken: string;
  readonly apiKey: string;
  readonly scalewayToken: string;
  readonly userAgent: string;
  readonly serverToken: string;
  readonly mailpaceToken: string;
  readonly lettermintToken: string;
  readonly heloChannelId: string;
  readonly heloIdempotencyKey: string;
  readonly body: string;
  readonly bodyBase64: string;
  readonly contentType: string;
  readonly idempotencyKey: string;
  readonly method: string;
  readonly path: string;
}

export interface EmailHttpFixture {
  readonly closed: Queue.Queue<boolean>;
  readonly received: Queue.Queue<ReceivedEmailHttpSubmission>;
  readonly server: Server;
  readonly url: string;
}

export interface EmailHttpReply {
  readonly next?: EmailHttpReply;
  readonly hold?: boolean;
  readonly body: string;
  readonly status: number;
  readonly retryAfter?: string;
  readonly idempotentReplayed?: string;
  readonly location?: string;
  readonly messageId?: string;
  readonly contentType?: string;
  readonly sesErrorType?: string;
}

const parseHeader = Schema.decodeUnknownOption(Schema.String);

export const startEmailHttpFixture = Effect.fnUntraced(function* startEmailHttpFixture(
  reply: EmailHttpReply,
): Effect.fn.Return<EmailHttpFixture, never, Scope.Scope> {
  const received = yield* Queue.unbounded<ReceivedEmailHttpSubmission>();
  const closed = yield* Queue.unbounded<boolean>();

  return yield* Effect.acquireRelease(
    Effect.callback<EmailHttpFixture>((resume) => {
      let currentReply = reply;

      const server = createServer((request, response) => {
        const responseReply = currentReply;
        currentReply = responseReply.next ?? responseReply;
        const chunks: Uint8Array[] = [];

        response.on("close", () => {
          Queue.offerUnsafe(closed, !response.writableEnded);
        });
        request.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        request.on("end", () => {
          const bytes = Buffer.concat(chunks);
          Queue.offerUnsafe(received, {
            apiKey: Option.getOrElse(parseHeader(request.headers["api-key"]), () => ""),
            apiToken: Option.getOrElse(parseHeader(request.headers["api-token"]), () => ""),
            authorization: request.headers.authorization ?? "",
            body: bytes.toString("utf-8"),
            bodyBase64: bytes.toString("base64"),
            contentType: request.headers["content-type"] ?? "",
            heloChannelId: Option.getOrElse(
              parseHeader(request.headers["x-helo-channel-id"]),
              () => "",
            ),
            heloIdempotencyKey: Option.getOrElse(
              parseHeader(request.headers["x-helo-idempotency-key"]),
              () => "",
            ),
            host: request.headers.host ?? "",
            idempotencyKey: Option.getOrElse(
              parseHeader(request.headers["idempotency-key"]),
              () => "",
            ),
            lettermintToken: Option.getOrElse(
              parseHeader(request.headers["x-lettermint-token"]),
              () => "",
            ),
            mailpaceToken: Option.getOrElse(
              parseHeader(request.headers["mailpace-server-token"]),
              () => "",
            ),
            method: request.method ?? "",
            path: request.url ?? "",
            scalewayToken: Option.getOrElse(parseHeader(request.headers["x-auth-token"]), () => ""),
            serverToken: Option.getOrElse(
              parseHeader(request.headers["x-postmark-server-token"]),
              () => "",
            ),
            sesDate: Option.getOrElse(parseHeader(request.headers["x-amz-date"]), () => ""),
            sesPayloadHash: Option.getOrElse(
              parseHeader(request.headers["x-amz-content-sha256"]),
              () => "",
            ),
            sesSessionToken: Option.getOrElse(
              parseHeader(request.headers["x-amz-security-token"]),
              () => "",
            ),
            sesSigningHost: Option.getOrElse(
              parseHeader(request.headers["x-fixture-ses-signing-host"]),
              () => "",
            ),
            userAgent: request.headers["user-agent"] ?? "",
          });

          if (responseReply.hold !== true) {
            if (responseReply.retryAfter !== undefined) {
              response.setHeader("Retry-After", responseReply.retryAfter);
            }

            if (responseReply.idempotentReplayed !== undefined) {
              response.setHeader("Idempotent-Replayed", responseReply.idempotentReplayed);
            }

            if (responseReply.location !== undefined) {
              response.setHeader("Location", responseReply.location);
            }

            if (responseReply.messageId !== undefined) {
              response.setHeader("X-Message-ID", responseReply.messageId);
            }

            if (responseReply.sesErrorType !== undefined) {
              response.setHeader("X-Amzn-Errortype", responseReply.sesErrorType);
            }

            response.writeHead(responseReply.status, {
              "Content-Type": responseReply.contentType ?? "application/json",
            });
            response.end(responseReply.body);
          }
        });
      });

      server.once("error", (error) => {
        resume(Effect.die(error));
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();

        if (address === null || Predicate.isString(address)) {
          resume(Effect.die("Email HTTP fixture did not bind an IP address"));

          return;
        }

        resume(
          Effect.succeed({ closed, received, server, url: `http://127.0.0.1:${address.port}` }),
        );
      });

      return Effect.sync(() => server.close());
    }),
    (fixture) =>
      Effect.callback<true>((resume) => {
        fixture.server.close((error) => {
          resume(error === undefined ? Effect.succeed(true) : Effect.die(error));
        });
        fixture.server.closeAllConnections();
      }),
  );
});

export const emailFixtureClientLayer = (
  url: string,
  expectedOrigin: string,
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* makeEmailFixtureClient() {
      const client = yield* HttpClient.HttpClient;

      return client.pipe(
        HttpClient.mapRequest((request) => {
          const endpoint = new URL(request.url);
          const local = new URL(url);

          assert.strictEqual(endpoint.origin, expectedOrigin);
          endpoint.protocol = local.protocol;
          endpoint.host = local.host;

          const rewritten = HttpClientRequest.setUrl(request, endpoint);

          if (request.headers["x-amz-date"] !== undefined) {
            const signingHost = request.headers.host;
            assert(signingHost !== undefined);
            assert.strictEqual(signingHost, new URL(expectedOrigin).host);

            return HttpClientRequest.setHeader(
              rewritten,
              "x-fixture-ses-signing-host",
              signingHost,
            );
          }

          return rewritten;
        }),
      );
    }),
  ).pipe(
    Layer.provide(
      FetchHttpClient.layer.pipe(
        Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { redirect: "manual" })),
      ),
    ),
  );
