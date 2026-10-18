import { Schema, Struct } from "effect";
import { EmailReceiptSchema } from "./email-message.js";

export const EmailAiReceiptSchema = Schema.Struct({
  receiptKind: Schema.Literals(Struct.keys(EmailReceiptSchema.cases)),
});

export type EmailAiReceipt = typeof EmailAiReceiptSchema.Type;
