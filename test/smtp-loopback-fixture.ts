import { readFileSync } from "node:fs";
import { createServer as createTcpServer } from "node:net";
import type { Socket } from "node:net";
import { createSecureContext, createServer as createTlsServer, TLSSocket } from "node:tls";
import { Effect, Predicate, Queue } from "effect";
import type { Scope } from "effect";

type SmtpFixturePhase = "Commands" | "Data" | "Plain" | "LoginUser" | "LoginPassword";

export interface SmtpFixtureOptions {
  readonly security: "ImplicitTls" | "StartTls";
  readonly hello?: string;
  readonly secureHello?: string;
  readonly greeting?: string;
  readonly mailReply?: string;
  readonly recipientCodes?: readonly number[];
  readonly finalReply?: string;
  readonly dataAction?: "Reply" | "Drop" | "Hold";
  readonly authReply?: string;
  readonly startTlsReply?: string;
  readonly fragments?: boolean;
}

export const startSmtpFixture = Effect.fnUntraced(function* startSmtpFixture(
  options: SmtpFixtureOptions,
): Effect.fn.Return<
  {
    readonly certificate: string;
    readonly port: number;
    readonly commands: Queue.Queue<string>;
    readonly data: Queue.Queue<string>;
    readonly closed: Queue.Queue<boolean>;
    readonly connected: Queue.Queue<boolean>;
  },
  never,
  Scope.Scope
> {
  const commands = yield* Queue.unbounded<string>();
  const data = yield* Queue.unbounded<string>();
  const closed = yield* Queue.unbounded<boolean>();
  const connected = yield* Queue.unbounded<boolean>();

  const certificate = readFileSync(
    new URL("smtp-loopback-test-only-certificate.pem", import.meta.url),
    "utf-8",
  );

  const key = readFileSync(new URL("smtp-loopback-test-only-key.pem", import.meta.url), "utf-8");
  const secureContext = createSecureContext({ cert: certificate, key });
  const sockets = new Set<Socket>();

  const track = (connection: Socket) => {
    sockets.add(connection);
    connection.on("error", () => {
      connection.destroy();
    });
    connection.once("close", () => {
      sockets.delete(connection);
      Queue.offerUnsafe(closed, true);
    });
  };

  const install = (initial: Socket, encrypted: boolean) => {
    let socket = initial;
    let secured = encrypted;
    let buffer = "";
    let body = "";
    let recipientIndex = 0;
    let phase: SmtpFixturePhase = "Commands";

    const reply = (text: string) => {
      if (options.fragments === true && text.length > 3) {
        socket.write(text.slice(0, 2));
        socket.write(text.slice(2));
      } else {
        socket.write(text);
      }
    };

    const handlers = new Map<string, (line: string) => void>([
      [
        "EHLO",
        () => {
          reply(
            secured
              ? (options.secureHello ?? "250-localhost\r\n250 AUTH PLAIN LOGIN\r\n")
              : (options.hello ?? "250-localhost\r\n250-STARTTLS\r\n250 AUTH PLAIN LOGIN\r\n"),
          );
        },
      ],
      [
        "AUTH",
        (line) => {
          phase = line === "AUTH PLAIN" ? "Plain" : "LoginUser";
          reply(phase === "Plain" ? "334 \r\n" : "334 VXNlcm5hbWU6\r\n");
        },
      ],
      [
        "MAIL",
        () => {
          reply(options.mailReply ?? "250 sender permitted\r\n");
        },
      ],
      [
        "RCPT",
        () => {
          const code = options.recipientCodes?.[recipientIndex] ?? 250;
          recipientIndex += 1;
          reply(`${code} private recipient response\r\n`);
        },
      ],
      [
        "DATA",
        () => {
          phase = "Data";
          reply("354 send content\r\n");
        },
      ],
      [
        "QUIT",
        () => {
          socket.end("221 goodbye\r\n");
        },
      ],
    ]);

    const phases: Record<SmtpFixturePhase, (line: string) => void> = {
      Commands: (line) => {
        Queue.offerUnsafe(commands, line);
        const command = line.split(" ")[0] ?? "";
        const handle = handlers.get(command);

        if (handle === undefined) {
          reply("500 unknown fixture command\r\n");
        } else {
          handle(line);
        }
      },
      Data: (line) => {
        if (line !== ".") {
          body += `${line.startsWith("..") ? line.slice(1) : line}\r\n`;

          return;
        }

        phase = "Commands";
        Queue.offerUnsafe(data, body);

        const actions = {
          Drop: () => {
            socket.destroy();
          },
          Hold: () => {
            socket.pause();
          },
          Reply: () => {
            reply(options.finalReply ?? "250 queued as private-queue-handle\r\n");
          },
        };

        actions[options.dataAction ?? "Reply"]();
      },
      LoginPassword: (line) => {
        Queue.offerUnsafe(commands, line);
        phase = "Commands";
        reply(options.authReply ?? "235 authenticated\r\n");
      },
      LoginUser: (line) => {
        Queue.offerUnsafe(commands, line);
        phase = "LoginPassword";
        reply("334 UGFzc3dvcmQ6\r\n");
      },
      Plain: (line) => {
        Queue.offerUnsafe(commands, line);
        phase = "Commands";
        reply(options.authReply ?? "235 authenticated\r\n");
      },
    };

    const receive = (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");
      let end = buffer.indexOf("\r\n");

      while (end !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        phases[phase](line);
        end = buffer.indexOf("\r\n");
      }
    };

    handlers.set("STARTTLS", () => {
      reply(options.startTlsReply ?? "220 begin secure connection\r\n");

      if (options.startTlsReply !== undefined) {
        return;
      }

      socket.off("data", receive);
      socket = new TLSSocket(socket, { isServer: true, secureContext });
      secured = true;
      track(socket);
      socket.on("data", receive);
    });
    track(socket);
    Queue.offerUnsafe(connected, true);
    socket.on("data", receive);
    reply(options.greeting ?? "220 localhost fictional fixture\r\n");
  };

  const server = yield* Effect.acquireRelease(
    Effect.callback<ReturnType<typeof createTcpServer>>((resume) => {
      const listener =
        options.security === "ImplicitTls"
          ? createTlsServer({ cert: certificate, key }, (socket) => {
              install(socket, true);
            })
          : createTcpServer((socket) => {
              install(socket, false);
            });

      listener.on("error", (error) => {
        resume(Effect.die(error));
      });
      listener.listen(0, "127.0.0.1", () => {
        resume(Effect.succeed(listener));
      });

      return Effect.sync(() => {
        listener.close();
      });
    }),
    (listener) =>
      Effect.callback<undefined>((resume) => {
        for (const socket of sockets) {
          socket.destroy();
        }

        listener.close(() => {
          resume(Effect.undefined);
        });
      }),
  );

  const address = server.address();

  if (address === null || Predicate.isString(address)) {
    return yield* Effect.die("SMTP fixture did not bind a loopback port");
  }

  return { certificate, closed, commands, connected, data, port: address.port };
});
