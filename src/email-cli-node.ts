import { readFileSync } from "node:fs";
import type { Readable } from "node:stream";
import { Effect, Layer } from "effect";
import { EmailCliEnvironment, maxEmailCliInputBytes } from "./email-cli-environment.js";
import { EmailCliError } from "./email-cli-error.js";

const readEmailCliStdin = Effect.fnUntraced(function* readEmailCliStdin(
  input: Readable,
): Effect.fn.Return<string, EmailCliError> {
  let cleanup = Effect.void;

  return yield* Effect.callback<Uint8Array, EmailCliError>((resume) => {
    if (
      input.destroyed ||
      input.readableEnded ||
      input.readableObjectMode ||
      input.readableEncoding !== null ||
      ("isTTY" in input && input.isTTY === true)
    ) {
      resume(Effect.fail(new EmailCliError({ reason: "input-unavailable" })));

      return;
    }

    const chunks: Uint8Array[] = [];
    let byteLength = 0;

    const onData = (chunk: Uint8Array) => {
      byteLength += chunk.byteLength;

      if (byteLength > maxEmailCliInputBytes) {
        input.pause();
        resume(Effect.fail(new EmailCliError({ reason: "input-limit" })));

        return;
      }

      chunks.push(Uint8Array.from(chunk));
    };

    const onEnd = () => {
      resume(Effect.succeed(Buffer.concat(chunks)));
    };

    const onError = () => {
      resume(Effect.fail(new EmailCliError({ reason: "input-unavailable" })));
    };

    const onClose = () => {
      if (!input.readableEnded) {
        onError();
      }
    };

    cleanup = Effect.sync(() => {
      input.pause();
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
      input.off("close", onClose);
    });
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
    input.once("close", onClose);
  }).pipe(
    Effect.ensuring(Effect.suspend(() => cleanup)),
    Effect.flatMap((bytes) =>
      Effect.try({
        catch: () => new EmailCliError({ reason: "invalid-utf8" }),
        try: () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
      }),
    ),
  );
});

export const nodeEmailCliEnvironmentLayer = (
  input: Readable,
  manifest: URL,
): Layer.Layer<EmailCliEnvironment> =>
  Layer.succeed(EmailCliEnvironment, {
    readDistribution: Effect.try({
      catch: () => new EmailCliError({ reason: "distribution-unavailable" }),
      try: () => readFileSync(manifest, "utf-8"),
    }),
    readRequest: readEmailCliStdin(input),
  });
