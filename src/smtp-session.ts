import { connect as connectTcp } from "node:net";
import type { Socket } from "node:net";
import { connect as connectTls, TLSSocket } from "node:tls";
import type { SecureContext } from "node:tls";
import { Effect, Result, Schema } from "effect";
import type { Scope } from "effect";
import { EmailDeliveryUnknown } from "./email-delivery-unknown.js";

export interface SmtpReply {
  readonly code: number;
  readonly lines: readonly string[];
}

export interface SmtpSession {
  readonly exchange: (command?: string) => Effect.Effect<SmtpReply, EmailDeliveryUnknown>;
  readonly socket: Socket;
}

export interface SmtpConnectionOptions {
  readonly host: string;
  readonly port: number;
  readonly security: "ImplicitTls" | "StartTls";
  readonly serverName: string;
  readonly secureContext: SecureContext;
}

const smtpUnknown = (reason: "transport" | "invalid-response") =>
  new EmailDeliveryUnknown({ provider: "smtp", reason });

const SmtpReplyLine = Schema.String.check(
  Schema.isMaxLength(510),
  Schema.isPattern(/^[2-5][0-5][0-9](?:[ -][\t\u0020-\u007E]*)?$/u),
);

interface SmtpReplyBuffer {
  pending: string;
  readonly lines: string[];
  code: number | undefined;
  bytes: number;
}

const parseSmtpReplyChunk = (
  state: SmtpReplyBuffer,
  chunk: Buffer,
): Result.Result<SmtpReply | null, EmailDeliveryUnknown> => {
  state.bytes += chunk.length;

  if (state.bytes > 16_384) {
    return Result.fail(smtpUnknown("invalid-response"));
  }

  state.pending += chunk.toString("latin1");
  let end = state.pending.indexOf("\r\n");

  while (end !== -1) {
    const line = state.pending.slice(0, end);
    state.pending = state.pending.slice(end + 2);

    if (Result.isFailure(Schema.decodeResult(SmtpReplyLine)(line))) {
      return Result.fail(smtpUnknown("invalid-response"));
    }

    const code = Number(line.slice(0, 3));

    if (state.code !== undefined && state.code !== code) {
      return Result.fail(smtpUnknown("invalid-response"));
    }

    state.code = code;
    state.lines.push(line.slice(4));

    if (state.lines.length > 32) {
      return Result.fail(smtpUnknown("invalid-response"));
    }

    if (line[3] !== "-") {
      return state.pending.length === 0
        ? Result.succeed({ code, lines: state.lines })
        : Result.fail(smtpUnknown("invalid-response"));
    }

    end = state.pending.indexOf("\r\n");
  }

  return state.pending.length > 511
    ? Result.fail(smtpUnknown("invalid-response"))
    : Result.succeed(null);
};

const exchangeSmtpReply = (socket: Socket, command?: string) =>
  Effect.callback<SmtpReply, EmailDeliveryUnknown>((resume) => {
    const state: SmtpReplyBuffer = { bytes: 0, code: undefined, lines: [], pending: "" };

    const releases: (() => void)[] = [];

    const cleanup = () => {
      socket.pause();

      for (const release of releases) {
        release();
      }
    };

    const finish = (result: Result.Result<SmtpReply, EmailDeliveryUnknown>) => {
      cleanup();
      resume(Effect.fromResult(result));
    };

    const onFailure = () => {
      finish(Result.fail(smtpUnknown("transport")));
    };

    const onData = (chunk: Buffer) => {
      Result.match(parseSmtpReplyChunk(state, chunk), {
        onFailure: (error) => {
          finish(Result.fail(error));
        },
        onSuccess: (reply) => {
          if (reply !== null) {
            finish(Result.succeed(reply));
          }
        },
      });
    };

    releases.push(() => {
      socket.off("data", onData);
      socket.off("error", onFailure);
      socket.off("end", onFailure);
      socket.off("close", onFailure);
    });

    if (socket.destroyed || socket.readableEnded) {
      onFailure();

      return Effect.void;
    }

    socket.on("data", onData);
    socket.once("error", onFailure);
    socket.once("end", onFailure);
    socket.once("close", onFailure);
    socket.resume();

    if (command !== undefined) {
      socket.write(command);
    }

    return Effect.sync(cleanup);
  });

const awaitSmtpTls = (socket: TLSSocket) =>
  Effect.callback<undefined, EmailDeliveryUnknown>((resume) => {
    const releases: (() => void)[] = [];

    const cleanup = () => {
      for (const release of releases) {
        release();
      }
    };

    const onReady = () => {
      cleanup();
      resume(socket.authorized ? Effect.undefined : Effect.fail(smtpUnknown("transport")));
    };

    const onFailure = () => {
      cleanup();
      resume(Effect.fail(smtpUnknown("transport")));
    };

    releases.push(() => {
      socket.off("secureConnect", onReady);
      socket.off("error", onFailure);
      socket.off("close", onFailure);
    });

    if (socket.authorized) {
      onReady();

      return Effect.void;
    }

    if (socket.destroyed) {
      onFailure();

      return Effect.void;
    }

    socket.once("secureConnect", onReady);
    socket.once("error", onFailure);
    socket.once("close", onFailure);

    return Effect.sync(cleanup);
  });

export const connectSmtpSession = Effect.fnUntraced(function* connectSmtpSession(
  options: SmtpConnectionOptions,
  existing?: Socket,
): Effect.fn.Return<SmtpSession, EmailDeliveryUnknown, Scope.Scope> {
  const socket = yield* Effect.acquireRelease(
    Effect.try({
      catch: () => smtpUnknown("transport"),
      try: () => {
        const connection =
          existing === undefined && options.security === "StartTls"
            ? connectTcp({ host: options.host, port: options.port })
            : connectTls({
                host: options.host,
                minVersion: "TLSv1.2",
                port: options.port,
                rejectUnauthorized: true,
                secureContext: options.secureContext,
                servername: options.serverName,
                socket: existing,
              });

        connection.pause();
        connection.on("error", () => {
          connection.destroy();
        });

        return connection;
      },
    }),
    (connection) =>
      Effect.sync(() => {
        connection.destroy();
      }),
  );

  if (socket instanceof TLSSocket) {
    yield* awaitSmtpTls(socket);
  }

  return { exchange: (command) => exchangeSmtpReply(socket, command), socket };
});
