// @effect-diagnostics nodeBuiltinImport:off -- Oxlint resolves SDK source ownership from this tooling module.
import path from "node:path";

const sdkRepositoryRoot = path.resolve(import.meta.dirname, "../../..");

const sdkIntegrationModules: Record<string, "Adapter" | "Composition"> = {
  "brevo-email-sender": "Adapter",
  "cloudflare-email-sender": "Adapter",
  "email-account-routing": "Composition",
  "email-ai-execution": "Adapter",
  "email-ai-tool": "Adapter",
  "email-capture-aggregate": "Composition",
  "email-cli": "Composition",
  "email-cli-main": "Composition",
  "email-cli-node": "Adapter",
  "email-http-execution": "Adapter",
  "email-http-protocol": "Adapter",
  "email-http-response": "Adapter",
  "email-native-capture": "Composition",
  "email-native-observations": "Composition",
  "email-observation-aggregate": "Composition",
  "email-provider": "Adapter",
  "email-react": "Adapter",
  "email-react-components": "Adapter",
  "email-submission-capture": "Composition",
  "email-submission-observations": "Composition",
  "graph-email-sender": "Adapter",
  "helo-email-sender": "Adapter",
  index: "Composition",
  "iterable-campaign-defaults": "Composition",
  "iterable-campaign-email": "Adapter",
  "jetemail-email-sender": "Adapter",
  "lettermint-email-sender": "Adapter",
  "lettr-email-sender": "Adapter",
  "loops-transactional-defaults": "Composition",
  "loops-transactional-email": "Adapter",
  "mailchimp-email-sender": "Adapter",
  "mailersend-email-sender": "Adapter",
  "mailgun-email-sender": "Adapter",
  "mailgun-webhook-verifier": "Adapter",
  "mailpace-email-sender": "Adapter",
  "mailtrap-email-sender": "Adapter",
  "plunk-email-sender": "Adapter",
  "postmark-email-sender": "Adapter",
  "primitive-email-sender": "Adapter",
  "resend-batch-email": "Adapter",
  "resend-email-payload": "Adapter",
  "resend-email-sender": "Adapter",
  "resend-webhook-verifier": "Adapter",
  "scaleway-email-sender": "Adapter",
  "sendgrid-email-sender": "Adapter",
  "sendheron-email-sender": "Adapter",
  "sequenzy-email-sender": "Adapter",
  "ses-email-sender": "Adapter",
  "ses-request-signature": "Adapter",
  "smtp-email-sender": "Adapter",
  "smtp-message": "Adapter",
  "smtp-session": "Adapter",
  "sparkpost-email-sender": "Adapter",
  "unosend-email-sender": "Adapter",
  "zeptomail-email-sender": "Adapter",
};

export const sdkRepositoryPath = (filename: string): string =>
  path.relative(sdkRepositoryRoot, path.resolve(filename)).split(path.sep).join("/");

export const sdkDevelopmentSource = (filename: string): boolean =>
  /\.(?:test|spec|tst)\.[cm]?[jt]sx?$/u.test(filename) ||
  /(?:^|\/)(?:test|tests|__tests__|__fixtures__)(?:\/|$)/u.test(filename);

export const sdkRuntimeSource = (filename: string): boolean =>
  filename.startsWith("src/") && !sdkDevelopmentSource(filename);

export const sdkIntegrationSource = (filename: string): boolean => {
  const module = /^src\/(?<name>[^/]+?)(?:\.[cm]?[jt]sx?)?$/u.exec(filename)?.groups?.name;

  return module !== undefined && Object.hasOwn(sdkIntegrationModules, module);
};

export const sdkImportPath = (filename: string, specifier: string): string | null => {
  if (specifier.startsWith(".")) {
    return path.posix.normalize(path.posix.join(path.posix.dirname(filename), specifier));
  }

  return path.isAbsolute(specifier) ? sdkRepositoryPath(specifier) : null;
};
