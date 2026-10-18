import { createHash, createHmac } from "node:crypto";
import { Redacted } from "effect";

export interface SesSigningInput {
  readonly accessKeyId: Redacted.Redacted;
  readonly secretAccessKey: Redacted.Redacted;
  readonly sessionToken?: Redacted.Redacted;
  readonly region: "us-east-1" | "us-west-2" | "eu-west-1";
  readonly body: string;
  readonly timestamp: string;
}

export const signSesEmailRequest = (input: SesSigningInput) => {
  const host = `email.${input.region}.amazonaws.com`;
  const payloadHash = createHash("sha256").update(input.body, "utf-8").digest("hex");

  const headers = {
    "content-type": "application/json",
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": input.timestamp,
  };

  const signed =
    input.sessionToken === undefined
      ? headers
      : { ...headers, "x-amz-security-token": Redacted.value(input.sessionToken) };

  const entries = Object.entries(signed).toSorted(([left], [right]) =>
    left < right ? -1 : Number(left > right),
  );

  const signedHeaders = entries.map(([name]) => name).join(";");

  const canonical = [
    "POST",
    "/v2/email/outbound-emails",
    "",
    entries.map(([name, value]) => `${name}:${value}\n`).join(""),
    signedHeaders,
    payloadHash,
  ].join("\n");

  const date = input.timestamp.slice(0, 8);
  const scope = `${date}/${input.region}/ses/aws4_request`;

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    input.timestamp,
    scope,
    createHash("sha256").update(canonical, "utf-8").digest("hex"),
  ].join("\n");

  const dateKey = createHmac("sha256", `AWS4${Redacted.value(input.secretAccessKey)}`)
    .update(date, "utf-8")
    .digest();

  const regionKey = createHmac("sha256", dateKey).update(input.region, "utf-8").digest();
  const serviceKey = createHmac("sha256", regionKey).update("ses", "utf-8").digest();
  const signingKey = createHmac("sha256", serviceKey).update("aws4_request", "utf-8").digest();
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf-8").digest("hex");

  return {
    ...signed,
    authorization: `AWS4-HMAC-SHA256 Credential=${Redacted.value(input.accessKeyId)}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
};
