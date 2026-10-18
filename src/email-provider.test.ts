import { assert, describe, it } from "@effect/vitest";
import {
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Queue,
  Redacted,
  Ref,
  Schema,
} from "effect";
import { HttpClientRequest } from "effect/http";
import { emailFixtureClientLayer, startEmailHttpFixture } from "../test/email-http-fixture.js";
import {
  Email,
  EmailConfigurationError,
  EmailDeliveryUnknown,
  EmailInvalidMessage,
  EmailMessageIdSchema,
  EmailReceiptSchema,
  EmailRejected,
  EmailSender,
  EmailSenderIdempotencySchema,
  parseEmailMessage,
} from "./index.js";
import {
  defineEmailHttpProvider,
  EmailHttpCredentialSchema,
  readEmailHttpJson,
} from "./email-provider.js";
import type { EmailHttpExchange, EmailProviderProfile } from "./email-provider.js";

const message = {
  body: { text: "private-body" },
  from: "sender@example.test",
  metadata: { "Opaque.Key": "private-metadata" },
  subject: "private-subject",
  to: ["recipient@example.test"],
} as const;

const configuration = Schema.Struct({ apiKey: EmailHttpCredentialSchema });

const options = { apiKey: Redacted.make("private-token") };

const profile: EmailProviderProfile = {
  capabilities: {
    attachmentContentTypes: "None",
    attachments: false,
    headers: "None",
    inlineAttachments: false,
    metadata: true,
    scheduling: false,
    tags: { asciiOnly: false, maxCount: 0 },
  },
  idempotency: EmailSenderIdempotencySchema.cases.KeyForwarding.make({}),
  provider: "authored",
  validate: () => Effect.void,
};

const acknowledgement = Schema.Struct({ ticket: EmailMessageIdSchema });

const makeExchange = (apiKey: Redacted.Redacted): EmailHttpExchange => ({
  request: (submission) =>
    HttpClientRequest.post("https://author.example.test/send").pipe(
      HttpClientRequest.bearerToken(Redacted.value(apiKey)),
      HttpClientRequest.bodyJson({
        body: submission.message.body,
        metadata: submission.message.metadata,
        subject: submission.message.subject,
      }),
      Effect.mapError(() => new EmailRejected({ provider: "authored", reason: "invalid-message" })),
    ),
  respond: (response) => {
    if (response.status !== 202) {
      return Effect.fail(
        new EmailDeliveryUnknown({
          provider: "authored",
          reason: "unexpected-status",
          status: response.status,
        }),
      );
    }

    return readEmailHttpJson(response, "authored").pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(acknowledgement)),
      Effect.mapError(
        () => new EmailDeliveryUnknown({ provider: "authored", reason: "invalid-response" }),
      ),
      Effect.map(({ ticket }) =>
        EmailReceiptSchema.cases.Accepted.make({ messageId: ticket, provider: "authored" }),
      ),
    );
  },
});

const AuthorAccount = Context.Service<{ readonly token: Redacted.Redacted }>("test/AuthorAccount");

class AuthorAcquisitionError extends Schema.TaggedError<AuthorAcquisitionError>()(
  "AuthorAcquisitionError",
  {},
) {}

const localClient = (url: string) => emailFixtureClientLayer(url, "https://author.example.test");

const submit = Effect.gen(function* submitAuthoredEmail() {
  return yield* (yield* Email).send(message, { idempotencyKey: "stable-key" });
});

describe("HTTP provider authoring", () => {
  it.effect("preflights owned intent without credentials, protocol acquisition or transport", () =>
    Effect.gen(function* preflightWithoutAccount() {
      const provider = defineEmailHttpProvider({
        configuration,
        makeProtocol: () => Effect.die("Protocol acquisition must not run during preflight"),
        profile,
        span: "Authored.submit",
      });

      const input = { ...message, metadata: { "Opaque.Key": "original" } };
      const prepared = yield* provider.preflight(input, { idempotencyKey: "stable-key" });
      input.metadata["Opaque.Key"] = "changed";
      assert.deepStrictEqual(prepared.metadata, { "Opaque.Key": "original" });

      const rejected = yield* provider
        .preflight({ ...message, sendAt: "2026-10-18T12:00:00Z" })
        .pipe(Effect.flip);

      assert(Schema.is(EmailInvalidMessage)(rejected));
    }),
  );

  it.effect(
    "enforces declared capabilities through the low-level sender before encoding unsupported intent",
    () =>
      Effect.gen(function* rejectDirectUnsupportedIntent() {
        const provider = defineEmailHttpProvider({
          configuration,
          makeProtocol: ({ apiKey }) => Effect.succeed(makeExchange(apiKey)),
          profile,
          span: "Authored.submit",
        });

        const fixture = yield* startEmailHttpFixture({
          body: '{"ticket":"must-not-submit"}',
          status: 202,
        });

        const unsupported = yield* parseEmailMessage({
          ...message,
          headers: [{ name: "X-Intent", value: "must-not-drop" }],
        });

        const failure = yield* Effect.gen(function* submitUnsupportedIntent() {
          return yield* (yield* EmailSender).submit({ message: unsupported });
        }).pipe(
          Effect.provide(
            provider.senderLayer(options).pipe(Layer.provide(localClient(fixture.url))),
          ),
          Effect.flip,
        );

        assert(Schema.is(EmailRejected)(failure));
        assert.strictEqual(failure.reason, "invalid-message");
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );

  it.effect(
    "keeps one owned profile authoritative despite definition mutation and excess hook members",
    () =>
      Effect.gen(function* preserveAuthorAuthority() {
        const mutableProfile = {
          ...profile,
          capabilities: { ...profile.capabilities, tags: { ...profile.capabilities.tags } },
          idempotency: EmailSenderIdempotencySchema.cases.KeyForwarding.make({}),
        };

        const definition = {
          configuration,
          makeProtocol: ({ apiKey }: typeof configuration.Type) =>
            Effect.succeed({
              ...makeExchange(apiKey),
              capabilities: { ...profile.capabilities, metadata: false },
              idempotency: EmailSenderIdempotencySchema.cases.Native.make({
                retention: Duration.hours(24),
              }),
              provider: "not-the-defined-provider",
              span: "NotTheDefinedSpan",
              validate: () => Effect.die("Hook metadata must not override the profile"),
            }),
          profile: mutableProfile,
          span: "Authored.submit",
        };

        const provider = defineEmailHttpProvider(definition);
        mutableProfile.capabilities.metadata = false;
        Reflect.set(mutableProfile.idempotency, "_tag", "None");
        Reflect.set(mutableProfile, "validate", () => Effect.die("Mutable definition leaked"));
        Reflect.set(definition, "makeProtocol", () => Effect.die("Mutable factory leaked"));
        yield* provider.preflight(message, { idempotencyKey: "stable-key" });

        const fixture = yield* startEmailHttpFixture({
          body: "private-server-failure",
          status: 500,
        });

        const failure = yield* submit.pipe(
          Effect.provide(
            provider
              .emailLayer(options, {
                deadline: Duration.seconds(5),
                initialDelay: Duration.millis(100),
                maxAttempts: 2,
              })
              .pipe(Layer.provide(localClient(fixture.url))),
          ),
          Effect.flip,
        );

        assert(Schema.is(EmailDeliveryUnknown)(failure));
        assert.strictEqual(failure.provider, "authored");
        assert.strictEqual(yield* Queue.size(fixture.received), 1);
        assert.notInclude(JSON.stringify(failure), "private");
      }),
  );

  it.effect(
    "rejects invalid configuration before protocol acquisition and redacts custom schema annotations",
    () =>
      Effect.gen(function* rejectPrivateConfiguration() {
        const provider = defineEmailHttpProvider({
          configuration: Schema.Struct({
            apiKey: EmailHttpCredentialSchema,
            tenant: Schema.String.check(
              Schema.makeFilter(() => false, { expected: "private-annotation-with-secret" }),
            ),
          }),
          makeProtocol: () => Effect.die("Invalid configuration reached protocol acquisition"),
          profile,
          span: "Authored.submit",
        });

        const fixture = yield* startEmailHttpFixture({
          body: '{"ticket":"accepted"}',
          status: 202,
        });

        const failure = yield* submit.pipe(
          Effect.provide(
            provider
              .emailLayer({ ...options, tenant: "private-tenant" })
              .pipe(Layer.provide(localClient(fixture.url))),
          ),
          Effect.flip,
        );

        assert(Schema.is(EmailConfigurationError)(failure));
        assert.notInclude(JSON.stringify(failure), "private");
        assert.notInclude(JSON.stringify(failure), "tenant");
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );

  it.effect(
    "retains captured account resources until the owning Layer closes and preserves opaque wire fields",
    () =>
      Effect.gen(function* acquireScopedAuthorAccount() {
        const active = yield* Ref.make(false);

        const provider = defineEmailHttpProvider({
          configuration,
          makeProtocol: () =>
            Effect.gen(function* acquireAuthorAccount() {
              const account = yield* AuthorAccount;

              const token = yield* Effect.acquireRelease(
                Ref.set(active, true).pipe(Effect.as(account.token)),
                () => Ref.set(active, false),
              );

              const exchange = makeExchange(token);

              return {
                request: (submission) =>
                  Ref.get(active).pipe(
                    Effect.flatMap((open) =>
                      open
                        ? exchange.request(submission)
                        : Effect.die("Account released before submission"),
                    ),
                  ),
                respond: exchange.respond,
              } satisfies EmailHttpExchange;
            }),
          profile,
          span: "Authored.submit",
        });

        const fixture = yield* startEmailHttpFixture({
          body: '{"ticket":"authored-ticket"}',
          status: 202,
        });

        yield* Effect.gen(function* useScopedAuthorAccount() {
          const email = yield* Email;
          const receipt = yield* email.send(message);
          assert.strictEqual(receipt._tag, "Accepted");
          assert.strictEqual(yield* Ref.get(active), true);
          yield* email.send(message);
          assert.strictEqual(yield* Ref.get(active), true);
        }).pipe(
          Effect.provide(
            provider.emailLayer(options).pipe(
              Layer.provide(
                Layer.merge(
                  localClient(fixture.url),
                  Layer.succeed(AuthorAccount, {
                    token: Redacted.make("captured-account-token"),
                  }),
                ),
              ),
            ),
          ),
        );
        assert.strictEqual(yield* Ref.get(active), false);
        const received = yield* Queue.take(fixture.received);
        assert.strictEqual(received.authorization, "Bearer captured-account-token");
        assert.deepStrictEqual(
          yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(received.body),
          {
            body: { text: "private-body" },
            metadata: { "Opaque.Key": "private-metadata" },
            subject: "private-subject",
          },
        );
      }),
  );

  it.effect(
    "preserves typed acquisition failures and defects rather than classifying them as submission evidence",
    () =>
      Effect.gen(function* failAuthorAcquisition() {
        const fixture = yield* startEmailHttpFixture({ body: '{"ticket":"unused"}', status: 202 });
        const failure = new AuthorAcquisitionError({});

        const provider = defineEmailHttpProvider({
          configuration,
          makeProtocol: () => Effect.fail(failure),
          profile,
          span: "Authored.submit",
        });

        assert.strictEqual(
          yield* submit.pipe(
            Effect.provide(
              provider.emailLayer(options).pipe(Layer.provide(localClient(fixture.url))),
            ),
            Effect.flip,
          ),
          failure,
        );

        const defect = defineEmailHttpProvider({
          configuration,
          makeProtocol: () => Effect.die("private-acquisition-defect"),
          profile,
          span: "Authored.submit",
        });

        const exit = yield* submit.pipe(
          Effect.provide(defect.emailLayer(options).pipe(Layer.provide(localClient(fixture.url)))),
          Effect.exit,
        );

        assert(Exit.hasDies(exit));
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );

  it.effect(
    "interrupts pending account acquisition and releases already acquired resources without submitting",
    () =>
      Effect.gen(function* interruptAuthorAcquisition() {
        const entered = yield* Deferred.make<boolean>();
        const released = yield* Ref.make(false);

        const provider = defineEmailHttpProvider({
          configuration,
          makeProtocol: () =>
            Effect.gen(function* waitForAuthorAccount() {
              yield* Effect.acquireRelease(Effect.void, () => Ref.set(released, true));
              yield* Deferred.succeed(entered, true);

              return yield* Effect.never;
            }),
          profile,
          span: "Authored.submit",
        });

        const fixture = yield* startEmailHttpFixture({ body: '{"ticket":"unused"}', status: 202 });

        const fiber = yield* submit.pipe(
          Effect.provide(
            provider.emailLayer(options).pipe(Layer.provide(localClient(fixture.url))),
          ),
          Effect.forkScoped,
        );

        yield* Deferred.await(entered);
        yield* Fiber.interrupt(fiber);
        assert(Exit.hasInterrupts(yield* Fiber.await(fiber)));
        assert.strictEqual(yield* Ref.get(released), true);
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );
});
