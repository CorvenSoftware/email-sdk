import { Effect, Predicate, Queue, Tracer } from "effect";

export const startEmailTraceFixture = Effect.fnUntraced(function* startEmailTraceFixture() {
  const spans = yield* Queue.unbounded<Tracer.NativeSpan>();

  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      Queue.offerUnsafe(spans, span);

      return span;
    },
  });

  const diagnostics = Queue.takeAll(spans).pipe(
    Effect.map((captured) =>
      JSON.stringify(
        captured.map((span) => ({
          attributes: [...span.attributes],
          events: span.events.map(([name, , attributes]) => ({ attributes, name })),
          exit: Predicate.isTagged(span.status, "Ended") ? span.status.exit : undefined,
          name: span.name,
        })),
      ),
    ),
  );

  return { diagnostics, spans, tracer };
});
