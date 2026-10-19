import { defineConfig } from "blume";
import sdkPackage from "../../package.json" with { type: "json" };
import docsDeployment from "./deployment.json" with { type: "json" };

export default defineConfig({
  agents: {
    catalog: false,
    llmsTxt: {
      details: `Corven Email SDK (\`@corvencore/email-sdk\`) provides an Effect service for validating and sending email through configured provider accounts. It requires Node.js ${sdkPackage.engines.node} and Effect ${sdkPackage.peerDependencies.effect}.

Use the [quickstart](/quickstart) to install the package and record an email offline. Then [configure a provider](/sending). Append \`.md\` to a guide URL to retrieve Markdown.

- Import \`Email\` from \`@corvencore/email-sdk\` and provider Layers from their public subpaths.
- Supply credentials and transport in the application. Disable automatic redirects, transport-level send retries and sensitive request logging.
- Store queue, scheduling and recovery state in the application. The SDK does not persist these records.
- An accepted receipt confirms provider acknowledgment, not delivery. An unknown result means the SDK could not determine whether the provider accepted the request.
- Retrying an unknown result requires provider-supported idempotency for the selected account, the same key and prepared request, an unexpired retention window and an eligible policy and error reason.
- Fallback is allowed only after an eligible definite rejection. It stops after an unknown outcome or terminal result.
- Agent sends require application approval of the prepared operation. Model confirmation and framework flags do not replace this check.`,
      enabled: true,
    },
    mcp: { enabled: false },
    skillMd: false,
  },
  ai: { assistant: { enabled: false }, openInChat: false },
  content: { root: "content" },
  deployment: { site: `https://${docsDeployment.hostname}` },
  description:
    "Send transactional email with Effect. Configure provider Layers, validate messages and handle typed submission outcomes.",
  feedback: false,
  navigation: {
    sidebar: {
      display: "group",
      items: [
        {
          items: [
            "/",
            "/getting-started/installation",
            "/quickstart",
            "/getting-started/credentials",
            "/sending",
          ],
          label: "Get started",
        },
        {
          items: [
            "/providers/field-support",
            "/providers/capabilities",
            "/providers/verification",
            "/providers/resend",
            "/providers/postmark",
            "/providers/sendgrid",
            "/providers/mailgun",
            "/providers/mailersend",
            "/providers/mailpace",
            "/providers/unosend",
            "/providers/lettermint",
            "/providers/plunk",
            "/providers/helo",
            "/providers/jetemail",
            "/providers/lettr",
            "/providers/sparkpost",
            "/providers/primitive",
            "/providers/mailtrap",
            "/providers/mailchimp",
            "/providers/scaleway",
            "/providers/zeptomail",
            "/providers/cloudflare",
            "/providers/ses",
            "/providers/graph",
            "/providers/smtp",
            "/providers/brevo",
            "/providers/sequenzy",
            "/providers/sendheron",
            { items: ["/providers/loops", "/providers/iterable"], label: "Native jobs" },
          ],
          label: "Providers",
          root: "/providers",
        },
        {
          items: [
            "/concepts/service-model",
            "/messages",
            "/concepts/sending-modes",
            "/reliability",
            "/concepts/idempotency",
            "/concepts/cancellation",
            "/concepts/privacy",
          ],
          label: "Core concepts",
        },
        {
          items: [
            "/composition/defaults",
            "/composition/transformations",
            "/composition/observations",
            "/composition/capture",
            "/composition/operations",
            "/composition/aggregation",
            "/composition/native-defaults",
            "/composition/native-instrumentation",
          ],
          label: "Composition",
          root: "/composition",
        },
        {
          items: [
            "/ui/components",
            "/ui/themes",
            {
              items: ["/ui/verification-code", "/ui/password-reset", "/ui/team-invite"],
              label: "Account",
            },
            { items: ["/ui/welcome", "/ui/trial-ending", "/ui/usage-alert"], label: "Product" },
            { items: ["/ui/receipt", "/ui/invoice-due", "/ui/refund-confirmed"], label: "Billing" },
          ],
          label: "Email UI",
          root: "/ui",
        },
        {
          items: [
            "/integrations/react",
            "/integrations/agent",
            "/integrations/ai",
            {
              items: [
                "/integrations/webhooks/resend",
                "/integrations/webhooks/mailgun",
                "/integrations/webhooks/postmark",
              ],
              label: "Webhooks",
              root: "/integrations/webhooks",
            },
          ],
          label: "Integrations",
          root: "/integrations",
        },
        {
          items: [
            "/batching-routing",
            "/guides/personalization",
            "/guides/scheduling",
            "/guides/testing",
            "/guides/production-pipeline",
            "/guides/troubleshooting",
            "/guides/migration",
            "/guides/provider-comparisons",
            "/guides/authoring-provider",
          ],
          label: "Guides",
        },
        { items: ["/agents"], label: "For agents" },
        {
          items: [
            "/reference/email",
            "/reference/message",
            "/reference/attachments",
            "/reference/options",
            "/reference/receipts",
            "/reference/errors",
            "/reference/sender",
            "/reference/routing",
            "/reference/callbacks",
            {
              items: [
                "/reference/cli/help",
                "/reference/cli/discover",
                "/reference/cli/providers",
                "/reference/cli/schema",
                "/reference/cli/validate",
              ],
              label: "CLI",
              root: "/reference/cli",
            },
            "/reference/scope",
          ],
          label: "Reference",
          root: "/reference",
        },
      ],
    },
  },
  seo: { og: { enabled: false }, rss: { enabled: false } },
  theme: { accent: "teal", mode: "system", radius: "md" },
  title: "Corven Email SDK",
  variables: {
    effectVersion: sdkPackage.peerDependencies.effect,
    nodeVersion: sdkPackage.engines.node,
    reactDomVersion: sdkPackage.peerDependencies["react-dom"],
    reactEmailRenderVersion: sdkPackage.peerDependencies["@react-email/render"],
    reactVersion: sdkPackage.peerDependencies.react,
    sdkVersion: sdkPackage.version,
  },
});
