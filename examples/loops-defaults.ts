import type { Layer } from "effect";
import { Effect } from "effect";
import { defaultedLoopsTransactionalLayer } from "../src/loops-transactional-defaults.js";
import { LoopsTransactionalEmail } from "../src/loops-transactional-email.js";

export const fictionalDefaultedLoopsSubmission = <E, R>(
  account: Layer.Layer<LoopsTransactionalEmail, E, R>,
) =>
  Effect.gen(function* sendDefaultedLoopsNotification() {
    const loops = yield* LoopsTransactionalEmail;

    return yield* loops.send(
      {
        dataVariables: { items: [{ amount: 0, title: "Fictional item" }] },
        email: "recipient@fictional.invalid",
        transactionalId: "host_selected_published_template",
      },
      { idempotencyKey: "caller-owned-logical-event" },
    );
  }).pipe(
    Effect.provide(
      defaultedLoopsTransactionalLayer(account, {
        dataVariables: { application: "Fictional application" },
        idempotencyKeyPrefix: "fictional-application/",
      }),
    ),
  );
