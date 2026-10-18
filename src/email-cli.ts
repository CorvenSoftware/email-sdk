import { Context, Effect, Layer, Match, Schema, Struct } from "effect";
import { preflightPostmarkEmail, postmarkEmailCapabilities } from "./postmark-email-sender.js";
import { preflightResendEmail, resendEmailCapabilities } from "./resend-email-sender.js";
import { preflightSendgridEmail, sendgridEmailCapabilities } from "./sendgrid-email-sender.js";
import { preflightMailgunEmail, mailgunEmailCapabilities } from "./mailgun-email-sender.js";
import {
  preflightMailersendEmail,
  mailersendEmailCapabilities,
} from "./mailersend-email-sender.js";
import { preflightMailpaceEmail, mailpaceEmailCapabilities } from "./mailpace-email-sender.js";
import { preflightUnosendEmail, unosendEmailCapabilities } from "./unosend-email-sender.js";
import { parseEmailBoundedJson } from "./email-bounded-json.js";
import { EmailCliEnvironment, maxEmailCliInputBytes } from "./email-cli-environment.js";
import { EmailCliError } from "./email-cli-error.js";
import { EmailSendOptionsSchema, EmailSendRequestSchema } from "./email-preparation.js";
import { emailOperationSpan } from "./email-tracing.js";

export interface EmailCliReport {
  readonly exitCode: 0 | 1 | 2;
  readonly stdout: string;
  readonly stderr: string;
}

export interface IEmailCli {
  readonly run: (arguments_: readonly string[]) => Effect.Effect<EmailCliReport>;
}

export class EmailCli extends Context.Service<EmailCli, IEmailCli>()(
  "@corven/email-sdk/EmailCli",
) {}

const cliProviders = {
  mailersend: { capabilities: mailersendEmailCapabilities, preflight: preflightMailersendEmail },
  mailgun: { capabilities: mailgunEmailCapabilities, preflight: preflightMailgunEmail },
  mailpace: { capabilities: mailpaceEmailCapabilities, preflight: preflightMailpaceEmail },
  postmark: { capabilities: postmarkEmailCapabilities, preflight: preflightPostmarkEmail },
  resend: { capabilities: resendEmailCapabilities, preflight: preflightResendEmail },
  sendgrid: { capabilities: sendgridEmailCapabilities, preflight: preflightSendgridEmail },
  unosend: { capabilities: unosendEmailCapabilities, preflight: preflightUnosendEmail },
};

const CliProviderName = Schema.Literals(Struct.keys(cliProviders));

const CliArguments = Schema.Union([
  Schema.Tuple([]),
  Schema.Tuple([
    Schema.Literals(["help", "--help", "discover", "providers", "schema", "validate"]),
  ]),
  Schema.Tuple([Schema.Literal("validate"), CliProviderName]),
]);

const CliDistribution = Schema.Struct({
  exports: Schema.Record(Schema.String, Schema.Unknown),
  name: Schema.Literal("@corven/email-sdk"),
  version: Schema.String.check(
    Schema.isPattern(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u),
    Schema.isMaxLength(64),
  ),
});

const CliEntrypoints = Schema.Array(
  Schema.String.check(Schema.isPattern(/^\.(?:\/[a-z0-9.-]+)?$/u), Schema.isMaxLength(80)),
);

const CliRequest = Schema.Struct({
  message: EmailSendRequestSchema.fields.message,
  options: Schema.optionalKey(Schema.toCodecJson(EmailSendOptionsSchema)),
});

const decodeCliRequest = Schema.decodeUnknownEffect(CliRequest, {
  errors: "all",
  onExcessProperty: "error",
});

const help =
  "Corven email SDK: offline inspection only.\n\ncorven-email help       Show this help.\ncorven-email discover   List installed public entrypoints as JSON; not provider capabilities.\ncorven-email providers  List implemented credential-free local preflight profiles.\ncorven-email validate <provider>  Validate stdin using the selected provider's local rules.\ncorven-email schema     Print a partial Effect JSON Schema document; validate is authoritative.\ncorven-email validate   Read one UTF-8 JSON EmailSendRequest from piped stdin (32 MiB maximum).\n\nDefault validation checks common message/options only. Selected profiles additionally check provider-local rules without credentials or sending; all other profiles remain unsupported. Remote configuration, authentication, approval, submission and delivery are NOT CHECKED. No credentials, environment/config discovery, dry-run send or live send commands are supported. Private input is never echoed.\n";

const reportOutput = (stdout: string): EmailCliReport =>
  Object.freeze({ exitCode: 0, stderr: "", stdout });

const reportFailure = (failure: EmailCliError): EmailCliReport =>
  Object.freeze({
    exitCode: failure.reason === "usage" ? 2 : 1,
    stderr: `${JSON.stringify({ error: "EmailCliError", reason: failure.reason, submission: "NotAttempted" })}\n`,
    stdout: "",
  });

export const emailCliLayer: Layer.Layer<EmailCli, never, EmailCliEnvironment> = Layer.effect(
  EmailCli,
  Effect.gen(function* acquireEmailCli() {
    const environment = yield* EmailCliEnvironment;

    const discover = Effect.gen(function* discoverEmailDistribution() {
      const text = yield* environment.readDistribution;

      if (new TextEncoder().encode(text).byteLength > 65_536) {
        return yield* new EmailCliError({ reason: "distribution-unavailable" });
      }

      const value = yield* parseEmailBoundedJson(text).pipe(
        Effect.mapError(() => new EmailCliError({ reason: "distribution-unavailable" })),
      );

      const metadata = yield* Schema.decodeUnknownEffect(CliDistribution)(value).pipe(
        Effect.mapError(() => new EmailCliError({ reason: "distribution-unavailable" })),
      );

      const entrypoints = yield* Schema.decodeUnknownEffect(CliEntrypoints)(
        Object.keys(metadata.exports),
      ).pipe(Effect.mapError(() => new EmailCliError({ reason: "distribution-unavailable" })));

      return reportOutput(
        `${JSON.stringify({
          entrypoints: entrypoints
            .filter((entrypoint) => entrypoint !== "./package.json")
            .toSorted(),
          name: metadata.name,
          providerCapabilities: "NotChecked",
          submission: "NotAttempted",
          version: metadata.version,
        })}\n`,
      );
    });

    const validate = Effect.fnUntraced(function* validateEmailCliRequest(
      provider?: typeof CliProviderName.Type,
    ) {
      const text = yield* environment.readRequest;

      if (new TextEncoder().encode(text).byteLength > maxEmailCliInputBytes) {
        return yield* new EmailCliError({ reason: "input-limit" });
      }

      const value = yield* parseEmailBoundedJson(text).pipe(
        Effect.mapError(
          (failure) =>
            new EmailCliError({
              reason: failure.reason === "payload-limit" ? "input-limit" : "invalid-json",
            }),
        ),
      );

      const request = yield* decodeCliRequest(value).pipe(
        Effect.mapError(() => new EmailCliError({ reason: "invalid-request" })),
      );

      if (provider !== undefined) {
        yield* cliProviders[provider]
          .preflight(request.message, request.options)
          .pipe(Effect.mapError(() => new EmailCliError({ reason: "invalid-request" })));

        return reportOutput(
          `${JSON.stringify({ authentication: "NotChecked", checks: "ProviderLocalPreflight", delivery: "NotChecked", provider, providerPreflight: "LocalOnly", submission: "NotAttempted", valid: true })}\n`,
        );
      }

      return reportOutput(
        `${JSON.stringify({ authentication: "NotChecked", checks: "CommonRequestOnly", delivery: "NotChecked", providerPreflight: "NotChecked", submission: "NotAttempted", valid: true })}\n`,
      );
    });

    const run = Effect.fnUntraced(
      function* runEmailCli(arguments_: readonly string[]) {
        const args = yield* Schema.decodeUnknownEffect(CliArguments)(arguments_).pipe(
          Effect.mapError(() => new EmailCliError({ reason: "usage" })),
        );

        return yield* Match.value(args[0] ?? "help").pipe(
          Match.when("help", () => Effect.succeed(reportOutput(help))),
          Match.when("--help", () => Effect.succeed(reportOutput(help))),
          Match.when("discover", () => discover),
          Match.when("providers", () =>
            Effect.succeed(
              reportOutput(
                `${JSON.stringify({ authentication: "NotChecked", coverage: "SelectedProfiles", providers: Object.entries(cliProviders).map(([name, profile]) => ({ capabilities: profile.capabilities, name, preflight: "LocalOnly" })), submission: "NotAttempted" })}\n`,
              ),
            ),
          ),
          Match.when("schema", () =>
            Effect.sync(() =>
              reportOutput(
                `${JSON.stringify({ constraints: "PartialProjection", document: Schema.toJsonSchemaDocument(CliRequest), validationAuthority: "corven-email validate" })}\n`,
              ),
            ),
          ),
          Match.when("validate", () => validate(args[1])),
          Match.exhaustive,
        );
      },
      Effect.match({ onFailure: reportFailure, onSuccess: (report) => report }),
      emailOperationSpan("EmailCli.run"),
    );

    return EmailCli.of({ run });
  }),
);
