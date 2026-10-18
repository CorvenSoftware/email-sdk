import { assert, describe, it } from "@effect/vitest";
import { Effect, Result, Schema } from "effect";
import {
  Email,
  EmailInvalidMessage,
  EmailRejected,
  emailAttachmentFromBytes,
  emailAttachmentFromArrayBuffer,
  emailAttachmentFromBlob,
} from "./index.js";
import type { EmailAttachmentInput, EmailMessageInput } from "./index.js";
import { RecordedEmails, recordingEmailLayer } from "./recording-email-sender.js";

const message = {
  body: { text: "A fictional attachment notification." },
  from: "sender@example.test",
  subject: "Synthetic attachment example",
  to: ["recipient@example.test"],
} as const;

const attachment = {
  contentBase64: "AP+ACg==",
  contentType: "application/octet-stream",
  filename: "sample.bin",
} as const;

const byteValues = Schema.NonEmptyArray(
  Schema.Int.check(Schema.isBetween({ maximum: 255, minimum: 0 })),
).check(Schema.isMaxLength(257));

const fullAttachment = {
  ...attachment,
  contentBase64: Buffer.alloc(1024 * 1024).toString("base64"),
};

const oversizedAttachment = {
  ...attachment,
  contentBase64: Buffer.alloc(1024 * 1024 + 1).toString("base64"),
};

const invalidAttachments = [
  { field: "filename", input: { ...attachment, filename: "../private.bin" } },
  { field: "filename", input: { ...attachment, filename: "private\\file.bin" } },
  { field: "filename", input: { ...attachment, filename: "private\r\nInjected.bin" } },
  { field: "filename", input: { ...attachment, filename: "private.bin." } },
  { field: "filename", input: { ...attachment, filename: `private${"x".repeat(255)}` } },
  { field: "contentType", input: { ...attachment, contentType: "private; charset=utf-8" } },
  { field: "contentType", input: { ...attachment, contentType: "text/private\r\nHeader" } },
  { field: "contentBase64", input: { ...attachment, contentBase64: "" } },
  { field: "contentBase64", input: { ...attachment, contentBase64: "AP+ACg==\n" } },
  { field: "contentBase64", input: { ...attachment, contentBase64: "AP-ACg==" } },
  { field: "contentBase64", input: { ...attachment, contentBase64: "AQ" } },
  { field: "contentBase64", input: { ...attachment, contentBase64: "AB==" } },
  { field: "contentBase64", input: { ...attachment, contentBase64: "AAB=" } },
  { field: "contentBase64", input: oversizedAttachment },
  { field: "<unsupported>", input: { ...attachment, path: "https://private.example/file" } },
  { field: "contentId", input: { ...attachment, contentId: "private\r\ninline-image" } },
];

describe("Email attachments", () => {
  it.effect.prop(
    "records original binary bytes after source buffers and constructed attachments are mutated",
    [byteValues],
    ([original]) =>
      Effect.gen(function* preserveAttachmentBytes() {
        const bytes = Uint8Array.from(original);

        const encoded = yield* emailAttachmentFromBytes(bytes, {
          contentType: "application/octet-stream",
          filename: "sample.bin",
        });

        const fromBuffer = yield* emailAttachmentFromArrayBuffer(bytes.buffer, {
          contentType: "application/octet-stream",
          filename: "sample.bin",
        });

        const fromBlob = yield* emailAttachmentFromBlob(new Blob([bytes], { type: "image/png" }), {
          contentType: "application/octet-stream",
          filename: "sample.bin",
        });

        bytes.fill(0);
        const email = yield* Email;

        for (const constructed of [encoded, fromBuffer, fromBlob]) {
          Reflect.set(constructed, "contentBase64", "AQ==");
          yield* email.send(
            { ...message, attachments: [constructed] },
            { idempotencyKey: "same-source-independent-content" },
          );
        }

        const records = yield* (yield* RecordedEmails).messages;
        assert.strictEqual(records.length, 1);
        const observed = records[0]?.attachments?.[0];
        assert.isDefined(observed);
        assert.deepStrictEqual([...Buffer.from(observed.contentBase64, "base64")], [...original]);
      }).pipe(Effect.provide(recordingEmailLayer)),
  );

  it.effect(
    "owns metadata before explicit Blob acquisition and rejects invalid placement without reading",
    () =>
      Effect.gen(function* observeBlobAcquisitionOrder() {
        const options = { contentType: "application/octet-stream", filename: "sample.dat" };
        let reads = 0;

        const blob = new Blob([new Uint8Array([0, 255])]);
        Object.defineProperty(blob, "arrayBuffer", {
          get() {
            reads += 1;
            options.contentType = "image/png";
            options.filename = "changed.png";

            return Blob.prototype.arrayBuffer.bind(blob);
          },
        });

        const invalid = yield* emailAttachmentFromBlob(blob, {
          ...options,
          disposition: "inline",
        }).pipe(Effect.flip);

        assert(Schema.is(EmailInvalidMessage)(invalid));
        assert.strictEqual(reads, 0);
        const encoded = yield* emailAttachmentFromBlob(blob, options);
        assert.strictEqual(reads, 1);
        assert.strictEqual(encoded.filename, "sample.dat");
        assert.strictEqual(encoded.contentType, "application/octet-stream");
        assert.deepStrictEqual([...Buffer.from(encoded.contentBase64, "base64")], [0, 255]);
      }),
  );

  it.effect("bounds native binary sources before reads and masks Blob acquisition failure", () =>
    Effect.gen(function* validateNativeBinarySources() {
      const options = { contentType: "ProviderSelected", filename: "sample.dat" } as const;

      for (const size of [0, 1024 * 1024 + 1]) {
        const bufferError = yield* emailAttachmentFromArrayBuffer(
          new ArrayBuffer(size),
          options,
        ).pipe(Effect.flip);

        const blob = new Blob([new Uint8Array(size)]);
        const observation = { reads: 0 };
        Object.defineProperty(blob, "arrayBuffer", {
          get() {
            observation.reads += 1;

            return Blob.prototype.arrayBuffer.bind(blob);
          },
        });
        const blobError = yield* emailAttachmentFromBlob(blob, options).pipe(Effect.flip);

        assert(Schema.is(EmailInvalidMessage)(bufferError));
        assert(Schema.is(EmailInvalidMessage)(blobError));
        assert.strictEqual(observation.reads, 0);
      }

      const unavailable = new Blob(["private-content"]);
      Reflect.set(unavailable, "arrayBuffer", () => {
        throw new Error("private-blob-content-and-path");
      });
      const failure = yield* emailAttachmentFromBlob(unavailable, options).pipe(Effect.flip);

      assert(Schema.is(EmailInvalidMessage)(failure));
      assert.notInclude(JSON.stringify(failure), "private");
      const detached = new ArrayBuffer(1);
      structuredClone(detached, { transfer: [detached] });

      const detachedError = yield* emailAttachmentFromArrayBuffer(detached, options).pipe(
        Effect.flip,
      );

      assert(Schema.is(EmailInvalidMessage)(detachedError));
    }),
  );

  it.effect.each(invalidAttachments)(
    "rejects unsafe attachment $field without recording or disclosing rejected values",
    ({ field, input }) =>
      Effect.gen(function* rejectUnsafeAttachment() {
        const email = yield* Email;
        const error = yield* email.send({ ...message, attachments: [input] }).pipe(Effect.flip);
        assert(Schema.is(EmailInvalidMessage)(error));
        assert(error.issues.some((issue) => issue.path === `attachments.0.${field}`));
        assert.notInclude(JSON.stringify(error), "private");

        if (input.contentBase64.length > 0) {
          assert.notInclude(JSON.stringify(error), input.contentBase64);
        }

        assert.strictEqual((yield* (yield* RecordedEmails).messages).length, 0);
      }).pipe(Effect.provide(recordingEmailLayer)),
  );

  it.effect(
    "accepts attachment budgets at their boundaries and rejects larger or empty lists",
    () =>
      Effect.gen(function* boundMessageAttachments() {
        const email = yield* Email;
        const ten: [EmailAttachmentInput, ...EmailAttachmentInput[]] = [attachment];

        for (let index = 1; index < 10; index += 1) {
          ten.push(attachment);
        }

        yield* email.send({ ...message, attachments: ten });

        const maximum = yield* emailAttachmentFromBytes(new Uint8Array(1024 * 1024), {
          contentType: "application/octet-stream",
          filename: "maximum.dat",
        });

        const bufferMaximum = yield* emailAttachmentFromArrayBuffer(new ArrayBuffer(1024 * 1024), {
          contentType: "application/octet-stream",
          filename: "maximum.dat",
        });

        const blobMaximum = yield* emailAttachmentFromBlob(
          new Blob([new Uint8Array(1024 * 1024)]),
          { contentType: "application/octet-stream", filename: "maximum.dat" },
        );

        yield* email.send({
          ...message,
          attachments: [maximum, bufferMaximum, blobMaximum, fullAttachment],
        });

        const invalidLists = [
          [...ten, attachment],
          [
            fullAttachment,
            fullAttachment,
            fullAttachment,
            fullAttachment,
            { ...attachment, contentBase64: "AA==" },
          ],
          [],
        ];

        for (const attachments of invalidLists) {
          const input: EmailMessageInput = { ...message, attachments: [attachment] };
          Reflect.set(input, "attachments", attachments);
          const error = yield* email.send(input).pipe(Effect.flip);
          assert(Schema.is(EmailInvalidMessage)(error));
          assert(
            error.issues.some(
              (issue) => issue.path === "attachments" || issue.path === "attachments.0",
            ),
          );
        }

        assert.strictEqual((yield* (yield* RecordedEmails).messages).length, 2);
      }).pipe(Effect.provide(recordingEmailLayer)),
  );

  it.effect(
    "rejects invalid byte construction and excess options through the typed failure channel",
    () =>
      Effect.gen(function* rejectInvalidByteConstruction() {
        for (const bytes of [new Uint8Array(), new Uint8Array(1024 * 1024 + 1)]) {
          const error = yield* emailAttachmentFromBytes(bytes, {
            contentType: "application/octet-stream",
            filename: "sample.bin",
          }).pipe(Effect.flip);

          assert(Schema.is(EmailInvalidMessage)(error));
          assert(error.issues.some((issue) => issue.path === "<root>"));
        }

        const options = {
          contentType: "application/octet-stream",
          filename: "sample.bin",
          path: "https://private.example/file",
        };

        const error = yield* emailAttachmentFromBytes(new Uint8Array([0]), options).pipe(
          Effect.flip,
        );

        assert(Schema.is(EmailInvalidMessage)(error));
        assert(error.issues.some((issue) => issue.path === "<unsupported>"));
        assert.notInclude(JSON.stringify(error), "private");
      }),
  );

  it.effect(
    "deduplicates equivalent attachment fields and rejects content, metadata, or list changes",
    () =>
      Effect.gen(function* deduplicateAttachments() {
        const email = yield* Email;
        const other = { ...attachment, contentBase64: "AQ==", filename: "other.bin" };
        const options = { idempotencyKey: "attachment/event-1" };

        const original = yield* email.send(
          { ...message, attachments: [attachment, other] },
          options,
        );

        const equivalent = { ...attachment };
        Reflect.deleteProperty(equivalent, "contentBase64");
        Reflect.set(equivalent, "contentBase64", attachment.contentBase64);

        const duplicate = yield* email.send(
          { ...message, attachments: [equivalent, other] },
          options,
        );

        assert.deepStrictEqual(duplicate, original);

        const changedLists: [EmailAttachmentInput, ...EmailAttachmentInput[]][] = [
          [{ ...attachment, filename: "changed.bin" }, other],
          [{ ...attachment, contentType: "text/plain" }, other],
          [{ ...attachment, contentType: "ProviderSelected" }, other],
          [{ ...attachment, contentBase64: "Ag==" }, other],
          [attachment],
          [other, attachment],
        ];

        const batch = yield* email.sendAll(
          [
            ...changedLists.map((attachments) => ({
              message: { ...message, attachments },
              options,
            })),
            { message, options },
          ],
          { concurrency: 6 },
        );

        for (const result of batch) {
          assert(Result.isFailure(result));
          assert(Schema.is(EmailRejected)(result.failure));
          assert.strictEqual(result.failure.reason, "idempotency-conflict");
        }

        assert.strictEqual((yield* (yield* RecordedEmails).messages).length, 1);
      }).pipe(Effect.provide(recordingEmailLayer)),
  );
});
