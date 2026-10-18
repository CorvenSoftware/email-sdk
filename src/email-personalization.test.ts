import { assert, describe, it } from "@effect/vitest";
import { Effect, Result, Schema } from "effect";
import {
  Email,
  EmailInvalidMessage,
  EmailInvalidOptions,
  formatEmailMailbox,
  renderEmailPersonalizedMessage,
} from "./index.js";
import { RecordedEmails, recordingEmailLayer } from "./recording-email-sender.js";

const template = {
  attachments: [
    { contentBase64: "AA==", contentType: "application/octet-stream", filename: "synthetic.dat" },
  ],
  body: {
    html: "<p>%recipient.name%: %recipient.count% / %recipient.active%</p>",
    text: "%recipient.name%: %recipient.count% / %recipient.active%",
  },
  from: "sender@example.test",
  subject: "Hello %recipient.name%",
} as const;

const recipients = [
  {
    idempotencyKey: "event/first",
    to: { address: "first@example.test", name: "First Synthetic Recipient" },
    variables: { active: false, count: 0, name: '<Fictional & "quoted">' },
  },
  {
    idempotencyKey: "event/missing",
    to: "missing@example.test",
    variables: { active: true, name: "Missing variable" },
  },
  {
    idempotencyKey: "event/third",
    to: "third@example.test",
    variables: { active: true, count: 3, name: "Third" },
  },
] as const;

describe("Email personalization", () => {
  it.effect(
    "expands one owned message per recipient, escapes HTML, preserves typed scalars, and settles missing variables in order",
    () =>
      Effect.gen(function* sendPersonalizedMessages() {
        const email = yield* Email;

        const first = yield* email.sendPersonalized(
          { message: template, recipients },
          { concurrency: 2 },
        );

        const [accepted, missing, last] = first;
        assert.isDefined(accepted);
        assert.isDefined(missing);
        assert.isDefined(last);
        assert(Result.isSuccess(accepted));
        assert(Result.isFailure(missing));
        assert(Schema.is(EmailInvalidMessage)(missing.failure));
        assert(Result.isSuccess(last));
        const records = yield* (yield* RecordedEmails).messages;
        assert.strictEqual(records.length, 2);
        assert.isDefined(records[0]);
        assert.isDefined(records[1]);
        assert.strictEqual(
          formatEmailMailbox(records[0].to[0]),
          '"First Synthetic Recipient" <first@example.test>',
        );
        assert.strictEqual(records[0].subject, 'Hello <Fictional & "quoted">');
        assert.strictEqual(records[0].body.text, '<Fictional & "quoted">: 0 / false');
        assert.strictEqual(
          records[0].body.html,
          "<p>&lt;Fictional &amp; &quot;quoted&quot;&gt;: 0 / false</p>",
        );
        assert.strictEqual(records[0].attachments?.[0].contentBase64, "AA==");
        assert.strictEqual(formatEmailMailbox(records[1].to[0]), "third@example.test");
        assert.strictEqual(records[1].body.text, "Third: 3 / true");
        const repeated = yield* email.sendPersonalized({ message: template, recipients });
        assert.deepStrictEqual(repeated[0], accepted);
        assert.deepStrictEqual(repeated[2], last);
        assert.strictEqual((yield* (yield* RecordedEmails).messages).length, 2);
      }).pipe(Effect.provide(recordingEmailLayer)),
  );

  it.effect(
    "refuses duplicate recipients or shared keys and invalid bounds before any personalized submission",
    () =>
      Effect.gen(function* rejectUnsafeAudience() {
        const email = yield* Email;

        const sameMailbox = {
          ...recipients[0],
          idempotencyKey: "event/different",
          to: "FIRST@EXAMPLE.TEST",
        };

        const sameKey = { ...recipients[0], to: "different@example.test" };

        for (const audience of [
          [recipients[0], sameMailbox],
          [recipients[0], { ...sameMailbox, to: '"Another name" <FIRST@EXAMPLE.TEST>' }],
          [recipients[0], sameKey],
        ] as const) {
          const error = yield* email
            .sendPersonalized({ message: template, recipients: audience })
            .pipe(Effect.flip);

          assert(Schema.is(EmailInvalidMessage)(error));
          assert.notInclude(JSON.stringify(error), "@example.test");
          assert.notInclude(JSON.stringify(error), "event/");
        }

        const bounds = yield* email
          .sendPersonalized({ message: template, recipients }, { concurrency: 0 })
          .pipe(Effect.flip);

        assert(Schema.is(EmailInvalidOptions)(bounds));

        const sharedOptions = {
          executionMetadata: { tenant: "private-context" },
          idempotencyKey: "private-shared-key",
        };

        const sharedKey = yield* email
          .sendPersonalized({ message: template, recipients }, sharedOptions)
          .pipe(Effect.flip);

        assert(Schema.is(EmailInvalidOptions)(sharedKey));
        assert.strictEqual(sharedKey.issues[0]?.path, "idempotencyKey");
        assert.notInclude(JSON.stringify(sharedKey), "private-shared-key");
        assert.strictEqual((yield* (yield* RecordedEmails).messages).length, 0);
      }).pipe(Effect.provide(recordingEmailLayer)),
  );

  it.effect(
    "previews without transport and rejects unresolved variables, subject injection, or explosive expansion through typed failures",
    () =>
      Effect.gen(function* renderSafelyWithoutSending() {
        const preview = yield* renderEmailPersonalizedMessage(template, recipients[0]);
        assert.strictEqual(preview.body.text, '<Fictional & "quoted">: 0 / false');

        const invalid = [
          {
            message: template,
            recipient: {
              ...recipients[0],
              variables: { active: true, count: 1, name: "private\r\nBcc: injected" },
            },
          },
          { message: { ...template, subject: "%recipient.toString%" }, recipient: recipients[0] },
          {
            message: { ...template, subject: "%recipient.private.name%" },
            recipient: recipients[0],
          },
          {
            message: {
              ...template,
              body: { text: "%recipient.name%".repeat(60_000) },
              subject: "Synthetic",
            },
            recipient: { ...recipients[0], variables: { name: "private".repeat(1400) } },
          },
        ];

        for (const input of invalid) {
          const error = yield* renderEmailPersonalizedMessage(input.message, input.recipient).pipe(
            Effect.flip,
          );

          assert(Schema.is(EmailInvalidMessage)(error));
          assert.notInclude(JSON.stringify(error), "private");
          assert.notInclude(JSON.stringify(error), "injected");
        }
      }),
  );
});
