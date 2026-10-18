import { Schema } from "effect";
import { EmailAddressSchema, emailMailboxAddress } from "./email-address.js";
import type { EmailMailbox } from "./email-address.js";
import type { EmailAttachment } from "./email-attachment.js";
import type { EmailMessage } from "./email-message.js";

export interface SmtpMessageHeaders {
  readonly date: string;
  readonly messageId: string;
}

const wrapSmtpBase64 = (encoded: string) => encoded.match(/.{1,76}/gu)?.join("\r\n") ?? "";

const encodeSmtpHeader = (text: string) => {
  const words: string[] = [];
  let word = "";

  for (const character of text) {
    if (Buffer.byteLength(word + character, "utf-8") > 36) {
      words.push(`=?UTF-8?B?${Buffer.from(word, "utf-8").toString("base64")}?=`);
      word = "";
    }

    word += character;
  }

  if (word.length > 0) {
    words.push(`=?UTF-8?B?${Buffer.from(word, "utf-8").toString("base64")}?=`);
  }

  return words.join("\r\n ");
};

const formatSmtpMailbox = (mailbox: EmailMailbox) => {
  const address = emailMailboxAddress(mailbox);

  return Schema.is(EmailAddressSchema)(mailbox) || mailbox.name === undefined
    ? address
    : `${encodeSmtpHeader(mailbox.name)}\r\n <${address}>`;
};

const smtpMultipart = (
  subtype: "mixed" | "related" | "alternative",
  parts: readonly string[],
  rootType?: "text/plain" | "text/html" | "multipart/alternative",
) => {
  const boundary = `=_corven_${subtype}`;

  return [
    `Content-Type: multipart/${subtype}; boundary="${boundary}"${rootType === undefined ? "" : `; type="${rootType}"`}`,
    "",
    ...parts.flatMap((part) => [`--${boundary}`, part]),
    `--${boundary}--`,
  ].join("\r\n");
};

const smtpBodyPart = (subtype: "plain" | "html", text: string) =>
  [
    `Content-Type: text/${subtype}; charset=utf-8`,
    "Content-Transfer-Encoding: base64",
    "",
    wrapSmtpBase64(
      Buffer.from(text.replaceAll(/\r\n|\r|\n/gu, "\r\n"), "utf-8").toString("base64"),
    ),
  ].join("\r\n");

const smtpAttachmentPart = (attachment: EmailAttachment) =>
  [
    `Content-Type: ${attachment.contentType}`,
    `Content-Disposition: ${attachment.contentId === undefined ? "attachment" : "inline"}; filename="${attachment.filename}"`,
    ...(attachment.contentId === undefined ? [] : [`Content-ID: <${attachment.contentId}>`]),
    "Content-Transfer-Encoding: base64",
    "",
    wrapSmtpBase64(attachment.contentBase64),
  ].join("\r\n");

const smtpContent = (message: EmailMessage) => {
  const bodies = [
    ...(message.body.text === undefined ? [] : [smtpBodyPart("plain", message.body.text)]),
    ...(message.body.html === undefined ? [] : [smtpBodyPart("html", message.body.html)]),
  ];

  let content = bodies.length === 1 ? bodies.join("") : smtpMultipart("alternative", bodies);

  const inline = (message.attachments ?? []).filter(
    (attachment) => attachment.contentId !== undefined,
  );

  const ordinary = (message.attachments ?? []).filter(
    (attachment) => attachment.contentId === undefined,
  );

  if (inline.length > 0) {
    const singleType = message.body.html === undefined ? "text/plain" : "text/html";
    const rootType = bodies.length > 1 ? "multipart/alternative" : singleType;

    content = smtpMultipart("related", [content, ...inline.map(smtpAttachmentPart)], rootType);
  }

  if (ordinary.length > 0) {
    content = smtpMultipart("mixed", [content, ...ordinary.map(smtpAttachmentPart)]);
  }

  return content;
};

export interface SmtpRenderedMessage {
  readonly data: string;
  readonly size: number;
}

const renderSmtpMessageData = (message: EmailMessage, headers: SmtpMessageHeaders): string => {
  const fields = [
    `Date: ${headers.date}`,
    `Message-ID: <${headers.messageId}>`,
    `From: ${formatSmtpMailbox(message.from)}`,
    `To: ${message.to.map(formatSmtpMailbox).join(",\r\n ")}`,
    ...(message.cc === undefined
      ? []
      : [`Cc: ${message.cc.map(formatSmtpMailbox).join(",\r\n ")}`]),
    ...(message.replyTo === undefined
      ? []
      : [`Reply-To: ${message.replyTo.map(formatSmtpMailbox).join(",\r\n ")}`]),
    `Subject: ${encodeSmtpHeader(message.subject)}`,
    ...(message.headers ?? []).map(({ name, value }) => `${name}: ${value}`),
    "MIME-Version: 1.0",
    smtpContent(message),
  ];

  return `${fields.join("\r\n").replaceAll(/^\./gmu, "..")}\r\n.\r\n`;
};

export const renderSmtpMessage = (
  message: EmailMessage,
  headers: SmtpMessageHeaders,
): SmtpRenderedMessage => {
  const data = renderSmtpMessageData(message, headers);

  return Object.freeze({
    data,
    size: Buffer.byteLength(data, "utf-8") - 3 - (data.match(/^\.\./gmu)?.length ?? 0),
  });
};
