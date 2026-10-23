import { Effect, Stream } from "effect";
import { sendEmailStream } from "../src/email-stream.js";
import { recordingEmailLayer } from "../src/recording-email-sender.js";

const fictionalAudience = Stream.fromIterable([
  "first@example.test",
  "second@example.test",
  "third@example.test",
]).pipe(
  Stream.map((recipient) => ({
    message: {
      body: { text: "This fictional stream stays in memory." },
      from: "sender@example.test",
      subject: "Fictional streaming notification",
      to: recipient,
    },
  })),
);

export const recordFictionalEmailStream = sendEmailStream(fictionalAudience, {
  concurrency: 2,
}).pipe(Stream.runCollect, Effect.provide(recordingEmailLayer));
