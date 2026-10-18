#!/usr/bin/env node
import { Cause, Effect, Exit, Layer } from "effect";
import { EmailCli, emailCliLayer } from "./email-cli.js";
import { nodeEmailCliEnvironmentLayer } from "./email-cli-node.js";

const environment = nodeEmailCliEnvironmentLayer(
  process.stdin,
  new URL("../package.json", import.meta.url),
);

const program = Effect.gen(function* runEmailCliMain() {
  const cli = yield* EmailCli;

  return yield* cli.run(process.argv.slice(2));
}).pipe(Effect.provide(emailCliLayer.pipe(Layer.provide(environment))));

process.stdout.on("error", () => {
  process.exitCode = 74;
});

process.stderr.on("error", () => {
  process.exitCode = 74;
});

Effect.runCallback(program, {
  onExit: (exit) => {
    if (Exit.isSuccess(exit)) {
      process.exitCode = exit.value.exitCode;
      process.stdout.write(exit.value.stdout);
      process.stderr.write(exit.value.stderr);

      return;
    }

    process.exitCode = Cause.hasInterrupts(exit.cause) ? 130 : 70;
    process.stderr.write(
      '{"error":"EmailCliError","reason":"internal-error","submission":"NotAttempted"}\n',
    );
  },
});
