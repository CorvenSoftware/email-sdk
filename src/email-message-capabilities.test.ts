import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect, Predicate, Schema } from "effect";
import { Email, EmailInvalidMessage, EmailRejected, formatEmailMailbox } from "./index.js";
import type { EmailMessageInput } from "./index.js";
import { RecordedEmails, recordingEmailLayer } from "./recording-email-sender.js";

const message = {
  attachments: [
    {
      contentBase64: "AA==",
      contentId: "logo",
      contentType: "image/png",
      disposition: "inline",
      filename: "logo.png",
    },
  ],
  body: { html: '<p>Synthetic <img src="cid:logo"></p>', text: "Synthetic" },
  from: { address: "sender@example.test", name: 'Synthetic, "Team" \\ café' },
  headers: [{ name: "X-Workflow", value: "synthetic" }],
  metadata: { alpha: "first", beta: "second" },
  sendAt: "2026-10-13T12:30:00Z",
  subject: "Synthetic rich message",
  tags: [{ name: "workflow", value: "synthetic" }],
  to: { address: "recipient@example.test", name: "Synthetic Recipient" },
} as const;

const invalidMessages = [
  { ...message, from: { ...message.from, name: "private\r\nBcc: injected@example.test" } },
  { ...message, from: { ...message.from, name: "private\u0001name" } },
  { ...message, from: "Private <sender@example.test>, Other <hidden@example.test>" },
  { ...message, from: "Private <sender@example.test> <hidden@example.test>" },
  { ...message, from: "Private\r\nBcc: hidden@example.test <sender@example.test>" },
  { ...message, from: '"Private\\q" <sender@example.test>' },
  { ...message, from: '"Private" trailing <sender@example.test>' },
  { ...message, from: '"" <sender@example.test>' },
  { ...message, from: "Private, Other <sender@example.test>" },
  { ...message, from: "Private <sender@example.test> trailing" },
  { ...message, headers: [{ name: "aUthORIZATION", value: "private-token" }] },
  { ...message, headers: [{ name: "Content-Type", value: "private-type" }] },
  { ...message, headers: [{ name: "X-Workflow", value: "private\r\nBcc: injected@example.test" }] },
  { ...message, headers: [{ name: "X-Workflow", value: "private\u007Fvalue" }] },
  { ...message, metadata: { "private-field-name": "private".repeat(200) } },
  { ...message, sendAt: "in 1 hour" },
  { ...message, sendAt: "2026-02-30T12:30:00Z" },
  { ...message, sendAt: "2026-10-13T25:30:00Z" },
  { ...message, sendAt: "2026-10-13T12:30:00" },
  { ...message, sendAt: "2026-02-30T12:30:00+05:30" },
  { ...message, sendAt: "2026-02-29T12:30:00-04:00" },
  { ...message, sendAt: "2026-10-13T24:00:00+01:00" },
  { ...message, sendAt: "2026-10-13T12:30:60+01:00" },
  { ...message, sendAt: "2026-10-13T12:30:00+24:00" },
  { ...message, sendAt: "2026-10-13T12:30:00+01:60" },
  { ...message, sendAt: "2026-10-13T12:30:00-00:00" },
  { ...message, sendAt: "2026-10-13T12:30:00.1234Z" },
  { ...message, attachments: [{ ...message.attachments[0], contentId: "cid:private" }] },
  { ...message, attachments: [{ ...message.attachments[0], disposition: "attachment" }] },
  { ...message, attachments: [message.attachments[0], message.attachments[0]] },
  { ...message, tags: [message.tags[0], message.tags[0]] },
] as const;

describe("Message preflight and rich ownership", () => {
  it.effect.prop(
    "formatted names preserve structured identity, escaping and recipient membership",
    {
      characters: Schema.NonEmptyArray(
        Schema.Literals(["A", "é", "😀", "中", ",", "<", ">", '"', "\\", " "]),
      ).check(Schema.isMaxLength(32)),
    },
    ({ characters }) =>
      Effect.gen(function* preserveFormattedMailboxIdentity() {
        const name = characters.join("");
        const email = yield* Email;
        const structured = { ...message, from: { address: message.from.address, name } };
        const parsed = yield* email.validate(structured);
        const encoded = formatEmailMailbox(parsed.from);
        const options = { idempotencyKey: "event/formatted-mailbox" };
        const original = yield* email.send(structured, options);
        assert.deepStrictEqual(yield* email.send({ ...message, from: encoded }, options), original);
        const [recorded] = yield* (yield* RecordedEmails).messages;
        assert.isDefined(recorded);
        assert(!Predicate.isString(recorded.from));
        assert.strictEqual(String(recorded.from.address), message.from.address);
        assert.strictEqual(recorded.from.name, name);
        assert.strictEqual(recorded.to.length, 1);
      }).pipe(Effect.provide(recordingEmailLayer)),
    { arbitrary: { runs: 24 } },
  );

  it.effect("normalizes named strings across all address fields before ordered batching", () =>
    Effect.gen(function* prepareFormattedRecipientFields() {
      const email = yield* Email;

      const input = {
        ...message,
        bcc: "Hidden <hidden@example.test>",
        cc: '"Copy, Team" <copy@example.test>',
        from: "Sender <sender@example.test>",
        replyTo: "Reply <reply@example.test>",
        to: "Recipient <recipient@example.test>",
      };

      const parsed = yield* email.validate(input);
      const results = yield* email.sendAll([{ message: parsed }, { message: input }]);
      assert.strictEqual(results.length, 2);
      const records = yield* (yield* RecordedEmails).messages;
      assert.strictEqual(records.length, 2);
      assert.deepStrictEqual(records[0], records[1]);
      assert.deepStrictEqual(parsed.to.map(formatEmailMailbox), [
        '"Recipient" <recipient@example.test>',
      ]);
      assert.deepStrictEqual(parsed.cc?.map(formatEmailMailbox), [
        '"Copy, Team" <copy@example.test>',
      ]);
      assert.deepStrictEqual(parsed.bcc?.map(formatEmailMailbox), [
        '"Hidden" <hidden@example.test>',
      ]);
      assert.deepStrictEqual(parsed.replyTo?.map(formatEmailMailbox), [
        '"Reply" <reply@example.test>',
      ]);
      assert.isFrozen(parsed.to[0]);
    }).pipe(Effect.provide(recordingEmailLayer)),
  );
  it.effect.prop(
    "equivalent offset, Date and UTC schedules keep one immutable keyed message identity",
    {
      epochMillis: Schema.Int.check(Schema.isBetween({ maximum: 4_102_444_800_000, minimum: 0 })),
      offsetMinutes: Schema.Int.check(Schema.isBetween({ maximum: 1439, minimum: -1439 })),
    },
    ({ epochMillis, offsetMinutes }) =>
      Effect.gen(function* preservePortableScheduleIdentity() {
        const instant = DateTime.makeUnsafe(epochMillis);
        const local = DateTime.add(instant, { minutes: offsetMinutes });
        const magnitude = Math.abs(offsetMinutes);
        const hours = String(Math.floor(magnitude / 60)).padStart(2, "0");
        const minutes = String(magnitude % 60).padStart(2, "0");
        const offset = `${offsetMinutes < 0 ? "-" : "+"}${hours}:${minutes}`;
        const encoded = `${DateTime.formatIso(local).slice(0, -1)}${offset}`;
        const date = DateTime.toDateUtc(instant);
        const options = { idempotencyKey: "event/portable-schedule" };
        const email = yield* Email;
        const parsed = yield* email.validate({ ...message, sendAt: date }, options);
        date.setTime(0);
        const original = yield* email.send(parsed, options);
        assert.deepStrictEqual(
          yield* email.send({ ...message, sendAt: encoded }, options),
          original,
        );
        assert.deepStrictEqual(
          yield* email.send({ ...message, sendAt: instant }, options),
          original,
        );
        const [recorded] = yield* (yield* RecordedEmails).messages;
        assert.isDefined(recorded?.sendAt);
        assert.strictEqual(DateTime.toEpochMillis(recorded.sendAt), epochMillis);
        assert.isFrozen(recorded.sendAt);
      }).pipe(Effect.provide(recordingEmailLayer)),
    { arbitrary: { runs: 24 } },
  );

  it.effect("refuses an invalid native Date before recording", () =>
    Effect.gen(function* rejectInvalidNativeSchedule() {
      const date = DateTime.toDateUtc(DateTime.makeUnsafe(0));
      date.setTime(Number.NaN);
      const failure = yield* (yield* Email).send({ ...message, sendAt: date }).pipe(Effect.flip);
      assert(failure instanceof EmailInvalidMessage);
      assert.notInclude(JSON.stringify(failure), "NaN");
      assert.strictEqual((yield* (yield* RecordedEmails).messages).length, 0);
    }).pipe(Effect.provide(recordingEmailLayer)),
  );
  it.effect(
    "preflights without submission, owns rich fields, and lets callers reuse the parsed message",
    () =>
      Effect.gen(function* ownValidatedMessage() {
        const email = yield* Email;
        const records = yield* RecordedEmails;
        const from = { ...message.from };
        const to = { ...message.to };
        const headers = [{ ...message.headers[0] }] as const;
        const tags = [{ ...message.tags[0] }] as const;
        const metadata = { ...message.metadata };
        const sendAt = DateTime.makeUnsafe(message.sendAt);
        const input = { ...message, from, headers, metadata, sendAt, tags, to };
        const parsed = yield* email.validate(input, { idempotencyKey: "event/rich" });
        assert.strictEqual((yield* records.messages).length, 0);
        Reflect.set(from, "name", "Changed");
        Reflect.set(to, "address", "changed@example.test");
        Reflect.set(headers[0], "value", "changed");
        Reflect.set(tags[0], "value", "changed");
        Reflect.set(metadata, "alpha", "changed");
        Reflect.set(sendAt, "epochMilliseconds", 0);
        assert(!Predicate.isString(parsed.from));
        assert.isDefined(parsed.headers);
        assert.isDefined(parsed.tags);
        assert.isDefined(parsed.metadata);
        Reflect.set(parsed.from, "name", "Observer mutation");
        Reflect.set(parsed.headers[0], "value", "Observer mutation");
        Reflect.set(parsed.tags[0], "value", "Observer mutation");
        Reflect.set(parsed.metadata, "alpha", "Observer mutation");
        assert.isDefined(parsed.sendAt);
        Reflect.set(parsed.sendAt, "epochMilliseconds", 0);
        Reflect.set(DateTime.toPartsUtc(parsed.sendAt), "year", 1970);
        yield* email.sendAll([{ message: parsed, options: { idempotencyKey: "event/rich" } }]);
        const [observed] = yield* records.messages;
        assert.isDefined(observed);
        assert.strictEqual(
          formatEmailMailbox(observed.from),
          '"Synthetic, \\"Team\\" \\\\ café" <sender@example.test>',
        );
        assert.strictEqual(
          formatEmailMailbox(observed.to[0]),
          '"Synthetic Recipient" <recipient@example.test>',
        );
        assert.strictEqual(observed.headers?.[0].value, "synthetic");
        assert.strictEqual(observed.tags?.[0].value, "synthetic");
        assert.strictEqual(observed.metadata?.alpha, "first");
        assert.isDefined(observed.sendAt);
        assert.strictEqual(DateTime.formatIso(observed.sendAt), "2026-10-13T12:30:00.000Z");
        assert.strictEqual(DateTime.toPartsUtc(observed.sendAt).year, 2026);
      }).pipe(Effect.provide(recordingEmailLayer)),
  );

  it.effect(
    "rejects injection, invalid scheduling, and ambiguous inline identity before recording with private diagnostics",
    () =>
      Effect.gen(function* rejectUnsafeRichFields() {
        const email = yield* Email;

        for (const input of invalidMessages) {
          const error = yield* email.send(input).pipe(Effect.flip);
          assert(Schema.is(EmailInvalidMessage)(error));
          assert.notInclude(JSON.stringify(error), "private");
        }

        assert.strictEqual((yield* (yield* RecordedEmails).messages).length, 0);
      }).pipe(Effect.provide(recordingEmailLayer)),
  );

  it.effect(
    "includes every rich field in keyed identity without depending on property insertion order",
    () =>
      Effect.gen(function* deduplicateRichIdentity() {
        const email = yield* Email;
        const options = { idempotencyKey: "event/rich-identity" };
        const first = yield* email.send(message, options);

        const equivalent = yield* email.send(
          {
            ...message,
            from: { address: message.from.address, name: message.from.name },
            headers: [{ name: "X-Workflow", value: "synthetic" }],
            metadata: { alpha: "first", beta: "second" },
            sendAt: DateTime.makeUnsafe("2026-10-13T12:30:00.000Z"),
            tags: [{ name: "workflow", value: "synthetic" }],
          },
          options,
        );

        assert.deepStrictEqual(equivalent, first);

        const variants: readonly EmailMessageInput[] = [
          { ...message, from: { ...message.from, name: "Changed" } },
          { ...message, to: { ...message.to, name: "Changed" } },
          { ...message, headers: [{ ...message.headers[0], value: "changed" }] },
          { ...message, metadata: { ...message.metadata, beta: "changed" } },
          { ...message, sendAt: "2026-10-13T12:30:01Z" },
          { ...message, tags: [{ ...message.tags[0], value: "changed" }] },
          { ...message, attachments: [{ ...message.attachments[0], contentId: "changed" }] },
          {
            ...message,
            attachments: [
              {
                contentBase64: "AA==",
                contentId: "logo",
                contentType: "image/png",
                filename: "logo.png",
              },
            ],
          },
        ];

        for (const variant of variants) {
          const error = yield* email.send(variant, options).pipe(Effect.flip);
          assert(Schema.is(EmailRejected)(error));
          assert.strictEqual(error.reason, "idempotency-conflict");
        }

        assert.strictEqual((yield* (yield* RecordedEmails).messages).length, 1);
      }).pipe(Effect.provide(recordingEmailLayer)),
  );
});
