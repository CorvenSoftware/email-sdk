import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import docsDeployment from "./docs/user/deployment.json" with { type: "json" };

export default Alchemy.Stack(
  "corven-email-sdk-docs",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* defineDocumentationResources() {
    const { stage } = yield* Alchemy.Stack;
    yield* Schema.decodeUnknownEffect(Schema.Literal("prod"))(stage).pipe(
      Effect.mapError((cause) => new Config.ConfigError(cause)),
    );

    const documentation = yield* Cloudflare.Worker("Documentation", {
      assets: {
        directory: "./docs/user/dist",
        htmlHandling: "drop-trailing-slash",
        notFoundHandling: "404-page",
      },
      compatibility: { date: "2026-10-18" },
      domain: docsDeployment.hostname,
      observability: { enabled: false },
      workersDev: false,
    });

    return { url: documentation.url };
  }),
);
