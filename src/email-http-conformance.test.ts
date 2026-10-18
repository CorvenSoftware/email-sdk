import { assert, describe, it } from "@effect/vitest";
import {
  DateTime,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Queue,
  Redacted,
  Result,
  Schema,
  Tracer,
} from "effect";
import { emailFixtureClientLayer, startEmailHttpFixture } from "../test/email-http-fixture.js";
import { startEmailTraceFixture } from "../test/email-tracing-fixture.js";
import { Email, EmailDeliveryUnknown, EmailInvalidMessage } from "./index.js";
import { postmarkEmailCapabilities, postmarkEmailLayer } from "./postmark-email-sender.js";
import { resendEmailCapabilities, resendEmailLayer } from "./resend-email-sender.js";
import { sendgridEmailCapabilities, sendgridEmailLayer } from "./sendgrid-email-sender.js";
import { mailgunEmailCapabilities, mailgunEmailLayer } from "./mailgun-email-sender.js";
import { mailersendEmailCapabilities, mailersendEmailLayer } from "./mailersend-email-sender.js";
import { mailpaceEmailCapabilities, mailpaceEmailLayer } from "./mailpace-email-sender.js";
import { unosendEmailCapabilities, unosendEmailLayer } from "./unosend-email-sender.js";
import { lettermintEmailCapabilities, lettermintEmailLayer } from "./lettermint-email-sender.js";
import { plunkEmailCapabilities, plunkEmailLayer } from "./plunk-email-sender.js";
import { heloEmailCapabilities, heloEmailLayer } from "./helo-email-sender.js";
import { jetemailEmailCapabilities, jetemailEmailLayer } from "./jetemail-email-sender.js";
import {
  lettrEmailCapabilities,
  lettrScheduledEmailCapabilities,
  lettrEmailLayer,
} from "./lettr-email-sender.js";
import { sparkpostEmailCapabilities, sparkpostEmailLayer } from "./sparkpost-email-sender.js";
import { primitiveEmailCapabilities, primitiveEmailLayer } from "./primitive-email-sender.js";
import { mailtrapEmailCapabilities, mailtrapEmailLayer } from "./mailtrap-email-sender.js";
import { mailchimpEmailCapabilities, mailchimpEmailLayer } from "./mailchimp-email-sender.js";
import { scalewayEmailCapabilities, scalewayEmailLayer } from "./scaleway-email-sender.js";
import { zeptomailEmailCapabilities, zeptomailEmailLayer } from "./zeptomail-email-sender.js";
import { graphEmailCapabilities, graphEmailLayer } from "./graph-email-sender.js";
import { cloudflareEmailCapabilities, cloudflareEmailLayer } from "./cloudflare-email-sender.js";
import { sesEmailCapabilities, sesEmailLayer } from "./ses-email-sender.js";
import { sendheronEmailCapabilities, sendheronEmailLayer } from "./sendheron-email-sender.js";
import { brevoEmailCapabilities, brevoEmailLayer } from "./brevo-email-sender.js";
import { sequenzyEmailCapabilities, sequenzyEmailLayer } from "./sequenzy-email-sender.js";
import type { EmailPersonalizedInput } from "./index.js";

const message = {
  attachments: [
    {
      contentBase64: Buffer.from("private-attachment-content").toString("base64"),
      contentType: "application/octet-stream",
      filename: "private-attachment.dat",
    },
  ],
  body: { text: "private-message-body" },
  from: "sender@example.test",
  subject: "private-message-subject",
  to: ["private-recipient@example.test"],
} as const;

const policy = {
  deadline: Duration.seconds(5),
  initialDelay: Duration.millis(100),
  maxAttempts: 1,
};

const providers = [
  {
    acceptedStatus: 201,
    acknowledgement: { messageId: "private-provider-id" },
    capabilities: brevoEmailCapabilities,
    jsonAcknowledgement: true,
    layer: () =>
      brevoEmailLayer(
        {
          apiKey: Redacted.make("private-api-token"),
          contentAuthority: "AuthorizeProviderRendering",
          submissionMode: "TransactionalOnly",
          tracking: "AuthorizeProviderTracking",
        },
        policy,
      ),
    message: {
      ...message,
      attachments: [
        {
          ...message.attachments[0],
          contentType: "ProviderSelected",
          filename: "private-file.pdf",
        },
      ],
      body: { html: "<p>private-message-body</p>" },
    } as const,
    options: {},
    origin: "https://api.brevo.com",
    span: "Brevo.submit",
    unsupported: [message, { ...message, metadata: { workflow: "private" } }] as const,
  },
  {
    acceptedStatus: 200,
    acknowledgement: { emailSendId: "private-provider-id", success: true, to: message.to[0] },
    capabilities: sequenzyEmailCapabilities,
    jsonAcknowledgement: true,
    layer: () =>
      sequenzyEmailLayer(
        {
          apiKey: Redacted.make("private-api-token"),
          automaticUtm: "AccountDisabled",
          contactWrites: "AuthorizeProviderManagedProfiles",
          contentAuthority: "AuthorizeProviderRenderingAndRetention",
          replyTracking: "AccountDisabled",
          senderIdentity: "ExistingVerifiedProfile",
          submissionMode: "TransactionalOnly",
        },
        policy,
      ),
    message: {
      ...message,
      body: { html: "<p>private-message-body</p>" },
      from: { address: message.from, name: "private-sender-name" },
      replyTo: "private-reply@example.test",
    } as const,
    options: {},
    origin: "https://api.sequenzy.com",
    span: "Sequenzy.submit",
    unsupported: [message, { ...message, metadata: { workflow: "private" } }] as const,
  },
  {
    acceptedStatus: 201,
    acknowledgement: {
      errorMessage: null,
      from: message.from,
      id: "private-provider-id",
      status: "sent",
      subject: message.subject,
      to: message.to[0],
    },
    capabilities: sendheronEmailCapabilities,
    jsonAcknowledgement: true,
    layer: () =>
      sendheronEmailLayer(
        {
          apiKey: Redacted.make("private-api-token"),
          submissionMode: "TransactionalOnly",
          tracking: "AuthorizeProviderTracking",
        },
        policy,
      ),
    message: {
      ...message,
      attachments: [{ ...message.attachments[0], contentType: "text/plain" }],
      body: { html: "<p>private-message-body</p>" },
      from: { address: message.from, name: "private-sender-name" },
      replyTo: ["private-reply@example.test"],
    } as const,
    options: {},
    origin: "https://api.sendheron.com",
    span: "Sendheron.submit",
    unsupported: [message, { ...message, metadata: { workflow: "private" } }] as const,
  },
  {
    acceptedStatus: 200,
    acknowledgement: { MessageId: "private-provider-id" },
    capabilities: sesEmailCapabilities,
    jsonAcknowledgement: true,
    layer: () =>
      sesEmailLayer(
        {
          accessKeyId: Redacted.make("AKIAFICTIONALEXAMPLE1"),
          mailFlow: "ProviderUnmodified",
          region: "us-east-1",
          secretAccessKey: Redacted.make("private-api-token"),
          sessionToken: Redacted.make("private-session-token"),
        },
        policy,
      ),
    message,
    options: {},
    origin: "https://email.us-east-1.amazonaws.com",
    span: "Ses.submit",
    unsupported: [
      { ...message, metadata: { workflow: "private" } },
      { ...message, sendAt: "2026-10-14T12:30:00Z" },
      { ...message, headers: [{ name: "X-SES-CONFIGURATION-SET", value: "private" }] },
    ] as const,
  },
  {
    acceptedStatus: 200,
    acknowledgement: {
      errors: [],
      messages: [],
      result: {
        delivered: [],
        message_id: "private-provider-id",
        permanent_bounces: [],
        queued: ["private-recipient@example.test"],
      },
      success: true,
    },
    capabilities: cloudflareEmailCapabilities,
    jsonAcknowledgement: true,
    layer: () =>
      cloudflareEmailLayer(
        {
          accountId: "0123456789abcdef0123456789abcdef",
          apiToken: Redacted.make("private-api-token"),
          mailFlow: "ProviderUnmodified",
        },
        policy,
      ),
    message,
    options: {},
    origin: "https://api.cloudflare.com",
    span: "Cloudflare.submit",
    unsupported: [
      { ...message, metadata: { workflow: "private" } },
      { ...message, replyTo: ["private-reply@example.test", "other@example.test"] },
      { ...message, headers: [{ name: "X-CF-Control", value: "private" }] },
    ] as const,
  },
  {
    acceptedStatus: 202,
    acknowledgement: {},
    capabilities: graphEmailCapabilities,
    jsonAcknowledgement: false,
    layer: () =>
      graphEmailLayer(
        {
          accessToken: Redacted.make("private-access-token"),
          mailFlow: "ProviderUnmodified",
          mailboxAddress: message.from,
          mailboxId: "33333333-3333-4333-8333-333333333333",
          senderIdentity: "OwnerOrSendAs",
          sentItems: "DoNotSave",
        },
        policy,
      ),
    message,
    options: {},
    origin: "https://graph.microsoft.com",
    span: "Graph.submit",
    unsupported: [
      { ...message, from: "private-foreign@example.test" },
      { ...message, body: { html: "<p>private-html</p>", text: "private-text" } },
      { ...message, metadata: { workflow: "private" } },
      { ...message, headers: [{ name: "X-MS-Exchange-Control", value: "private" }] },
    ] as const,
  },
  {
    acceptedStatus: 200,
    acknowledgement: {
      data: [{ additional_info: [], code: "EM_104" }],
      message: "OK",
      request_id: "private-provider-id",
    },
    capabilities: zeptomailEmailCapabilities,
    jsonAcknowledgement: true,
    layer: () =>
      zeptomailEmailLayer(
        { agentMode: "Live", apiKey: Redacted.make("private-api-token") },
        policy,
      ),
    message,
    options: {},
    origin: "https://cpaas.zoho.com",
    span: "Zeptomail.submit",
    unsupported: [
      { ...message, metadata: { workflow: "private" } },
      { ...message, sendAt: "2026-10-14T12:30:00Z" },
      { ...message, headers: [{ name: "X-TM-OPEN-TRACK", value: "true" }] },
    ] as const,
  },
  {
    acceptedStatus: 200,
    acknowledgement: {
      emails: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          mail_from: message.from,
          mail_rcpt: "private-recipient@example.test",
          message_id: "22222222-2222-4222-8222-222222222222",
          project_id: "33333333-3333-4333-8333-333333333333",
          rcpt_type: "to",
          status: "new",
          subject: message.subject,
        },
      ],
    },
    capabilities: scalewayEmailCapabilities,
    jsonAcknowledgement: true,
    layer: () =>
      scalewayEmailLayer(
        {
          projectId: "33333333-3333-4333-8333-333333333333",
          secretKey: Redacted.make("private-api-token"),
          tracking: "ProviderDisabled",
        },
        policy,
      ),
    message: {
      ...message,
      attachments: [{ ...message.attachments[0], contentType: "text/plain" }],
    } as const,
    options: {},
    origin: "https://api.scaleway.com",
    span: "Scaleway.submit",
    unsupported: [
      message,
      { ...message, metadata: { workflow: "private" } },
      { ...message, sendAt: "2026-10-14T12:30:00Z" },
    ] as const,
  },
  {
    acceptedStatus: 200,
    acknowledgement: [
      { _id: "private-provider-id", email: "private-recipient@example.test", status: "sent" },
    ],
    capabilities: mailchimpEmailCapabilities,
    jsonAcknowledgement: true,
    layer: () =>
      mailchimpEmailLayer(
        {
          apiKey: Redacted.make("private-api-token"),
          automaticFooter: "AccountDisabled",
          keyMode: "Live",
          messageRules: "AccountDisabled",
        },
        policy,
      ),
    message,
    options: {},
    origin: "https://mandrillapp.com",
    span: "Mailchimp.submit",
    unsupported: [
      { ...message, sendAt: "2026-10-14T12:30:00.001Z" },
      { ...message, tags: [{ name: "private-tag", value: "private-value" }] },
      { ...message, metadata: { workflow: "private-value".repeat(50) } },
      { ...message, headers: [{ name: "X-MC-Track", value: "private-value" }] },
    ] as const,
  },

  {
    acceptedStatus: 200,
    acknowledgement: { message_ids: ["private-provider-id"], success: true },
    capabilities: mailtrapEmailCapabilities,
    jsonAcknowledgement: true,
    layer: () =>
      mailtrapEmailLayer(
        {
          apiKey: Redacted.make("private-api-token"),
          automaticBcc: "DomainDisabled",
          automaticFooter: "DomainDisabled",
          tracking: "DomainDisabled",
        },
        policy,
      ),
    message,
    options: {},
    origin: "https://send.api.mailtrap.io",
    span: "Mailtrap.submit",
    unsupported: [
      { ...message, sendAt: "2026-10-14T12:30:00Z" },
      { ...message, replyTo: ["private-reply@example.test", "other@example.test"] },
      { ...message, headers: [{ name: "X-MT-Category", value: "private-value" }] },
    ] as const,
  },

  {
    acceptedStatus: 200,
    acknowledgement: {
      data: {
        accepted: ["private-recipient@example.test"],
        id: "11111111-1111-4111-8111-111111111111",
        idempotent_replay: false,
        queue_id: "private-queue",
        rejected: [],
        status: "submitted_to_agent",
      },
      success: true,
    },
    capabilities: primitiveEmailCapabilities,
    jsonAcknowledgement: true,
    layer: () =>
      primitiveEmailLayer(
        {
          apiKey: Redacted.make("prim_private-api-token"),
          keylessSends: "AllowContentDeduplication",
          tracking: "ProviderDisabled",
        },
        policy,
      ),
    message,
    options: { idempotencyKey: "private-idempotency-key" },
    origin: "https://api.primitive.dev",
    span: "Primitive.submit",
    unsupported: [
      { ...message, replyTo: "private-reply@example.test" },
      { ...message, headers: [{ name: "X-Workflow", value: "private-value" }] },
      { ...message, sendAt: "2026-10-14T12:30:00Z" },
      { ...message, tags: [{ name: "private-tag", value: "private-value" }] },
    ] as const,
  },

  {
    acceptedStatus: 200,
    acknowledgement: {
      results: {
        id: "private-provider-id",
        total_accepted_recipients: 1,
        total_rejected_recipients: 0,
      },
    },
    capabilities: sparkpostEmailCapabilities,
    jsonAcknowledgement: true,
    layer: () => sparkpostEmailLayer({ apiKey: Redacted.make("private-api-token") }, policy),
    message,
    options: { idempotencyKey: "private-idempotency-key" },
    origin: "https://api.sparkpost.com",
    span: "SparkPost.submit",
    unsupported: [
      { ...message, cc: "private-cc@example.test" },
      { ...message, tags: [{ name: "private-tag", value: "private-value" }] },
      { ...message, attachments: [{ ...message.attachments[0], contentType: "ProviderSelected" }] },
    ] as const,
  },

  {
    acceptedStatus: 200,
    acknowledgement: { data: { accepted: 1, rejected: 0, request_id: "private-provider-id" } },
    capabilities: lettrEmailCapabilities,
    jsonAcknowledgement: true,
    layer: () =>
      lettrEmailLayer(
        { apiKey: Redacted.make("lttr_private-api-token"), submissionMode: "Immediate" },
        policy,
      ),
    message,
    options: { idempotencyKey: "private-idempotency-key" },
    origin: "https://app.lettr.com",
    span: "Lettr.submit",
    unsupported: [
      {
        ...message,
        to: [{ address: "private-recipient@example.test", name: "private-recipient-name" }],
      },
      { ...message, sendAt: "2026-10-14T12:30:00Z" },
      { ...message, attachments: [{ ...message.attachments[0], contentType: "ProviderSelected" }] },
      { ...message, headers: [{ name: "X-MSYS-API", value: "private-value" }] },
    ] as const,
  },
  {
    acceptedStatus: 201,
    acknowledgement: {
      data: {
        accepted: 1,
        failure_reason: null,
        num_recipients: 1,
        recipients: ["private-recipient@example.test"],
        rejected: 0,
        request_id: "sch_01JQZ3N2K8XW9V6M4TBRC7YHDE",
        scheduled_at: "2026-10-14T12:30:00.123Z",
        state: "scheduled",
        transmission_id: null,
      },
    },
    capabilities: lettrScheduledEmailCapabilities,
    jsonAcknowledgement: true,
    layer: () =>
      lettrEmailLayer(
        { apiKey: Redacted.make("lttr_private-api-token"), submissionMode: "Scheduled" },
        policy,
      ),
    message: { ...message, sendAt: "2026-10-14T12:30:00.123Z" } as const,
    options: {},
    origin: "https://app.lettr.com",
    span: "Lettr.submit",
    unsupported: [
      message,
      {
        ...message,
        headers: [{ name: "Message-ID", value: "private-value" }],
        sendAt: "2026-10-14T12:30:00.123Z",
      },
    ] as const,
  },
  {
    acceptedStatus: 201,
    acknowledgement: { id: "synthetic-ack" },
    capabilities: jetemailEmailCapabilities,
    jsonAcknowledgement: true,
    layer: () =>
      jetemailEmailLayer(
        {
          apiKey: Redacted.make("transactional_private-api-token"),
          automaticBcc: "DomainDisabled",
          tracking: "DomainDisabled",
        },
        policy,
      ),
    message: {
      ...message,
      attachments: [{ ...message.attachments[0], contentType: "ProviderSelected" }],
      from: { address: message.from, name: "private-sender" },
    } as const,
    options: { idempotencyKey: "private-idempotency-key" },
    origin: "https://api.jetemail.com",
    span: "JetEmail.submit",
    unsupported: [
      message,
      { ...message, from: { address: message.from, name: "private-sender" } },
      {
        ...message,
        attachments: [
          { ...message.attachments[0], contentId: "private-cid", contentType: "ProviderSelected" },
        ],
        from: { address: message.from, name: "private-sender" },
      },
      {
        ...message,
        from: { address: message.from, name: "private-sender" },
        metadata: { workflow: "private" },
      },
    ] as const,
  },
  {
    acceptedStatus: 200,
    acknowledgement: { messageId: "01930f2a-4b3c-7d8e-9f0a-1b2c3d4e5f6a", status: "accepted" },
    capabilities: heloEmailCapabilities,
    jsonAcknowledgement: true,
    layer: () =>
      heloEmailLayer({ apiKey: Redacted.make("private-api-token"), channelMode: "Live" }, policy),
    message,
    options: { idempotencyKey: "private-idempotency-key" },
    origin: "https://api.helohq.com",
    span: "Helo.submit",
    unsupported: [
      { ...message, subject: `private-${"x".repeat(256)}` },
      { ...message, tags: [{ name: "private:name", value: "value" }] },
      { ...message, metadata: { workflow: "private-".repeat(20) } },
      { ...message, sendAt: "2026-10-13T12:30:00Z" },
    ] as const,
  },
  {
    acceptedStatus: 200,
    acknowledgement: {
      data: {
        emails: [{ contact: { email: "private-recipient@example.test" }, email: "synthetic-ack" }],
      },
      success: true,
    },
    capabilities: plunkEmailCapabilities,
    jsonAcknowledgement: true,
    layer: () =>
      plunkEmailLayer(
        {
          apiKey: Redacted.make("sk_private-api-token"),
          contactWrites: "AllowUpsert",
          tracking: "ProjectDisabled",
        },
        policy,
      ),
    message: { ...message, body: { html: "private-message-body" } },
    options: { idempotencyKey: "private-idempotency-key" },
    origin: "https://next-api.useplunk.com",
    span: "Plunk.submit",
    unsupported: [
      {
        ...message,
        body: { html: "private-message-body" },
        metadata: { workflow: "private-value" },
      },
      { ...message, body: { html: "private-message-body" }, cc: "private-copy@example.test" },
      {
        ...message,
        body: { html: "private-message-body" },
        to: ["private-one@example.test", "private-two@example.test"],
      },
    ] as const,
  },
  {
    acceptedStatus: 202,
    acknowledgement: { message_id: "synthetic-ack", status: "pending" },
    capabilities: lettermintEmailCapabilities,
    jsonAcknowledgement: true,
    layer: () => lettermintEmailLayer({ apiToken: Redacted.make("private-api-token") }, policy),
    message,
    options: { idempotencyKey: "private-idempotency-key" },
    origin: "https://api.lettermint.co",
    span: "Lettermint.submit",
    unsupported: [
      { ...message, tags: [{ name: "workflow", value: "private value" }] },
      {
        ...message,
        attachments: [
          { ...message.attachments[0], contentId: "private-cid", disposition: "inline" },
        ],
      },
      { ...message, headers: [{ name: "X-Lettermint-Token", value: "private-token" }] },
    ] as const,
  },
  {
    acceptedStatus: 200,
    acknowledgement: { data: { id: "synthetic-ack" }, success: true },
    capabilities: unosendEmailCapabilities,
    jsonAcknowledgement: true,
    layer: () => unosendEmailLayer({ apiKey: Redacted.make("private-api-token") }, policy),
    message: {
      ...message,
      attachments: [{ ...message.attachments[0], contentType: "text/plain" }],
    } as const,
    options: {},
    origin: "https://api.unosend.co",
    span: "Unosend.submit",
    unsupported: [
      { ...message, attachments: [{ ...message.attachments[0], contentId: "private-cid" }] },
      { ...message, metadata: { workflow: "private-value" } },
      { ...message, replyTo: ["reply@example.test", "other@example.test"] },
    ] as const,
  },
  {
    acceptedStatus: 200,
    acknowledgement: { id: 123, status: "pending" },
    capabilities: mailpaceEmailCapabilities,
    jsonAcknowledgement: true,
    layer: () => mailpaceEmailLayer({ serverToken: Redacted.make("private-api-token") }, policy),
    message: {
      ...message,
      attachments: [{ ...message.attachments[0], filename: "private-attachment.txt" }],
    } as const,
    options: {},
    origin: "https://app.mailpace.com",
    span: "MailPace.submit",
    unsupported: [
      { ...message, attachments: [{ ...message.attachments[0], filename: "private.data.txt" }] },
      { ...message, headers: [{ name: "X-Workflow", value: "private-value" }] },
      { ...message, metadata: { workflow: "private-value" } },
      { ...message, sendAt: "2026-10-13T12:30:00Z" },
    ] as const,
  },
  {
    acceptedStatus: 200,
    acknowledgement: { id: "provider-message-1" },
    capabilities: resendEmailCapabilities,
    jsonAcknowledgement: true,
    layer: () => resendEmailLayer({ apiKey: Redacted.make("private-api-token") }, policy),
    message,
    options: { idempotencyKey: "private-idempotency-key" },
    origin: "https://api.resend.com",
    span: "Resend.submit",
    unsupported: [
      { ...message, metadata: { workflow: "private-workflow" } },
      {
        ...message,
        headers: [
          { name: "X-Workflow", value: "private-first" },
          { name: "x-workflow", value: "private-second" },
        ],
      },
      { ...message, tags: [{ name: "private-workflow", value: "private value" }] },
    ] as const,
  },
  {
    acceptedStatus: 200,
    acknowledgement: { ErrorCode: 0, MessageID: "provider-message-1" },
    capabilities: postmarkEmailCapabilities,
    jsonAcknowledgement: true,
    layer: () => postmarkEmailLayer({ serverToken: Redacted.make("private-api-token") }, policy),
    message,
    options: {},
    origin: "https://api.postmarkapp.com",
    span: "Postmark.submit",
    unsupported: [
      { ...message, sendAt: "2026-10-13T12:30:00Z" },
      { ...message, tags: [{ name: "private:workflow", value: "private-value" }] },
      {
        ...message,
        tags: [
          { name: "workflow", value: "private-first" },
          { name: "other", value: "private-second" },
        ],
      },
      { ...message, from: { address: message.from, name: `private${"x".repeat(240)}` } },
    ] as const,
  },
  {
    acceptedStatus: 202,
    acknowledgement: {},
    capabilities: sendgridEmailCapabilities,
    jsonAcknowledgement: false,
    layer: () => sendgridEmailLayer({ apiKey: Redacted.make("private-api-token") }, policy),
    message,
    options: {},
    origin: "https://api.sendgrid.com",
    span: "SendGrid.submit",
    unsupported: [
      { ...message, from: { address: message.from, name: "private Café" } },
      { ...message, headers: [{ name: "X-SG-ID", value: "private-id" }] },
      { ...message, tags: [{ name: "private:workflow", value: "value" }] },
      { ...message, tags: [{ name: "workflow", value: "private café" }] },
      { ...message, tags: [{ name: "workflow", value: "x".repeat(250) }] },
      {
        ...message,
        metadata: {
          a: "é".repeat(1000),
          b: "é".repeat(1000),
          c: "é".repeat(1000),
          d: "é".repeat(1000),
          e: "é".repeat(1000),
          workflow: "private",
        },
      },
      { ...message, metadata: {} },
      { ...message, sendAt: "2026-10-13T12:30:00.001Z" },
      { ...message, cc: message.to },
      { ...message, replyTo: ["reply@example.test", "reply@example.test"] },
    ] as const,
  },
  {
    acceptedStatus: 200,
    acknowledgement: { id: "<provider-message-1@mg.example.test>" },
    capabilities: mailgunEmailCapabilities,
    jsonAcknowledgement: true,
    layer: () =>
      mailgunEmailLayer(
        { apiKey: Redacted.make("private-api-token"), domain: "mg.example.test" },
        policy,
      ),
    message,
    options: {},
    origin: "https://api.mailgun.net",
    span: "Mailgun.submit",
    unsupported: [
      { ...message, attachments: [{ ...message.attachments[0], contentId: "private-id" }] },
      { ...message, tags: [{ name: "private:workflow", value: "value" }] },
      { ...message, tags: [{ name: "workflow", value: "private café" }] },
      { ...message, tags: [{ name: "workflow", value: "x".repeat(128) }] },
      {
        ...message,
        tags: [
          { name: "Workflow", value: "synthetic" },
          { name: "workflow", value: "synthetic" },
        ],
      },
      {
        ...message,
        metadata: {
          a: "é".repeat(1000),
          b: "é".repeat(1000),
          c: "é".repeat(1000),
          d: "é".repeat(1000),
          e: "é".repeat(1000),
          f: "é".repeat(1000),
          g: "é".repeat(1000),
          h: "é".repeat(1000),
          i: "é".repeat(1000),
          workflow: "private",
        },
      },
      { ...message, metadata: { workflow: "private\nline" } },
      { ...message, sendAt: "2026-10-13T12:30:00.001Z" },
      { ...message, body: { text: "private\uD800" } },
    ] as const,
  },
  {
    acceptedStatus: 202,
    acknowledgement: {},
    capabilities: mailersendEmailCapabilities,
    jsonAcknowledgement: false,
    layer: () => mailersendEmailLayer({ apiKey: Redacted.make("private-api-token") }, policy),
    message: {
      ...message,
      attachments: [
        {
          ...message.attachments[0],
          contentType: "ProviderSelected",
          filename: "private-attachment.txt",
        },
      ],
    } as const,
    options: {},
    origin: "https://api.mailersend.com",
    span: "MailerSend.submit",
    unsupported: [
      message,
      {
        body: message.body,
        from: message.from,
        metadata: { label: "private-value" },
        subject: message.subject,
        to: message.to,
      },
    ] as const,
  },
];

const prepareLettrConformanceSchedule = Effect.fnUntraced(function* prepareLettrConformanceSchedule(
  definition: (typeof providers)[number],
) {
  if (
    definition.origin !== "https://app.lettr.com" ||
    !("sendAt" in definition.message) ||
    !("data" in definition.acknowledgement) ||
    !("scheduled_at" in definition.acknowledgement.data)
  ) {
    return definition;
  }

  const sendAt = DateTime.formatIso(DateTime.add(yield* DateTime.now, { minutes: 10 }));

  return {
    ...definition,
    acknowledgement: {
      ...definition.acknowledgement,
      data: { ...definition.acknowledgement.data, scheduled_at: sendAt },
    },
    message: { ...definition.message, sendAt },
  };
});

for (const definition of providers) {
  describe(`${definition.span} HTTP conformance`, () => {
    it.live(
      "preflights locally and refuses unsupported intent through validation, send, and batches without HTTP",
      () =>
        Effect.gen(function* preflightProviderIntent() {
          const provider = yield* prepareLettrConformanceSchedule(definition);

          const fixture = yield* startEmailHttpFixture({
            body: JSON.stringify(provider.acknowledgement),
            status: 200,
          });

          yield* Effect.gen(function* validateWithoutHttp() {
            const email = yield* Email;
            yield* email.validate(provider.message, provider.options);
            Reflect.set(email.capabilities, "metadata", true);
            Reflect.set(email.capabilities.tags, "maxCount", 100);
            Reflect.set(provider.capabilities.tags, "maxCount", 100);

            for (const unsupported of provider.unsupported) {
              const validation = yield* email.validate(unsupported).pipe(Effect.flip);
              const submission = yield* email.send(unsupported).pipe(Effect.flip);
              assert(Schema.is(EmailInvalidMessage)(validation));
              assert(Schema.is(EmailInvalidMessage)(submission));
              assert.notInclude(JSON.stringify(validation), "private");
              assert.notInclude(JSON.stringify(submission), "private");
              const batch = yield* email.sendAll([{ message: unsupported }]);
              assert.isDefined(batch[0]);
              assert(Result.isFailure(batch[0]));
              assert(Schema.is(EmailInvalidMessage)(batch[0].failure));
              assert(batch[0].failure.issues.every((issue) => issue.path.startsWith("message.")));
            }
          }).pipe(
            Effect.provide(
              provider
                .layer()
                .pipe(Layer.provide(emailFixtureClientLayer(fixture.url, provider.origin))),
            ),
          );
          assert.strictEqual(yield* Queue.size(fixture.received), 0);
        }),
    );

    it.live("aborts owned HTTP work when the caller interrupts pending acknowledgement", () =>
      Effect.gen(function* interruptAcknowledgement() {
        const provider = yield* prepareLettrConformanceSchedule(definition);
        const fixture = yield* startEmailHttpFixture({ body: "", hold: true, status: 200 });

        const fiber = yield* Effect.gen(function* sendPendingMessage() {
          return yield* (yield* Email).send(provider.message);
        }).pipe(
          Effect.provide(
            provider
              .layer()
              .pipe(Layer.provide(emailFixtureClientLayer(fixture.url, provider.origin))),
          ),
          Effect.forkScoped,
        );

        yield* Queue.take(fixture.received);
        yield* Fiber.interrupt(fiber);
        assert(Exit.hasInterrupts(yield* Fiber.await(fiber)));
        assert.strictEqual(yield* Queue.take(fixture.closed), true);
      }),
    );

    if (definition.jsonAcknowledgement) {
      it.live.each([
        { body: "not-json-private-provider-details", label: "malformed JSON" },
        {
          body: JSON.stringify(
            Array.isArray(definition.acknowledgement)
              ? definition.acknowledgement.map((recipient) => ({
                  ...recipient,
                  metadata: `private-${"x".repeat(1024 * 1024)}`,
                }))
              : { ...definition.acknowledgement, metadata: `private-${"x".repeat(1024 * 1024)}` },
          ),
          label: "oversized acknowledgement",
        },
      ])("keeps $label uncertain, private, and non-replayed", (scenario) =>
        Effect.gen(function* rejectUnsafeAcknowledgement() {
          const provider = yield* prepareLettrConformanceSchedule(definition);

          const fixture = yield* startEmailHttpFixture({
            body: scenario.body,
            status: provider.acceptedStatus,
          });

          const error = yield* Effect.gen(function* sendUncertainMessage() {
            return yield* (yield* Email).send(provider.message);
          }).pipe(
            Effect.provide(
              provider
                .layer()
                .pipe(Layer.provide(emailFixtureClientLayer(fixture.url, provider.origin))),
            ),
            Effect.flip,
          );

          assert(Schema.is(EmailDeliveryUnknown)(error));
          assert.strictEqual(error.reason, "invalid-response");
          assert.notInclude(JSON.stringify(error), "private-");
          assert.strictEqual(yield* Queue.size(fixture.received), 1);
        }),
      );
    }

    it.live("does not follow redirects or transfer submission credentials to a new endpoint", () =>
      Effect.gen(function* rejectSubmissionRedirect() {
        const provider = yield* prepareLettrConformanceSchedule(definition);

        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify(provider.acknowledgement),
          location: "/redirected",
          status: 307,
        });

        const error = yield* Effect.gen(function* sendRedirectedMessage() {
          return yield* (yield* Email).send(provider.message);
        }).pipe(
          Effect.provide(
            provider
              .layer()
              .pipe(Layer.provide(emailFixtureClientLayer(fixture.url, provider.origin))),
          ),
          Effect.flip,
        );

        assert(Schema.is(EmailDeliveryUnknown)(error));
        assert.strictEqual(error.reason, "unexpected-status");
        assert.strictEqual(yield* Queue.size(fixture.received), 1);
      }),
    );

    it.live.each([false, true])(
      "retains private-safe spans for successful and failed operations (success: %s)",
      (success) =>
        Effect.gen(function* observeSubmissionSpans() {
          const provider = yield* prepareLettrConformanceSchedule(definition);

          const fixture = yield* startEmailHttpFixture({
            body: success
              ? JSON.stringify(provider.acknowledgement)
              : '{"Message":"private-provider-details"}',
            messageId: "provider-message-1",
            status: success ? provider.acceptedStatus : 200,
          });

          const trace = yield* startEmailTraceFixture();

          const outcome = yield* Effect.gen(function* sendPrivateMessage() {
            const email = yield* Email;

            if (success) {
              const prepared = yield* email.validate(provider.message, provider.options);

              const settled = yield* email.sendAll([
                { message: provider.message, options: provider.options },
              ]);

              assert.isDefined(settled[0]);
              assert(Result.isSuccess(settled[0]));

              let personalizedTemplate: EmailPersonalizedInput["message"] = {
                body:
                  "html" in provider.message.body
                    ? { html: "private-%recipient.name%" }
                    : { text: "private-%recipient.name%" },
                from: provider.message.from,
                subject: message.subject,
              };

              if (prepared.sendAt !== undefined) {
                personalizedTemplate = { ...personalizedTemplate, sendAt: prepared.sendAt };
              }

              if (prepared.replyTo !== undefined) {
                personalizedTemplate = { ...personalizedTemplate, replyTo: prepared.replyTo };
              }

              const personalized = yield* email.sendPersonalized({
                message: personalizedTemplate,
                recipients: [{ to: provider.message.to[0], variables: { name: "private-name" } }],
              });

              assert.isDefined(personalized[0]);
              assert(Result.isSuccess(personalized[0]));
            }

            return yield* email.send(provider.message, provider.options);
          }).pipe(
            Effect.provide(
              provider
                .layer()
                .pipe(Layer.provide(emailFixtureClientLayer(fixture.url, provider.origin))),
            ),
            Effect.provideService(Tracer.Tracer, trace.tracer),
            Effect.result,
          );

          const content = yield* trace.diagnostics;

          assert.strictEqual(Result.isSuccess(outcome), success);
          assert.include(content, provider.span);
          assert.notInclude(content, "private-");
          assert.notInclude(content, message.attachments[0].contentBase64);
        }),
    );
  });
}
