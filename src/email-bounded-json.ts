import { Effect, Schema } from "effect";

class EmailJsonError extends Schema.TaggedError<EmailJsonError>()("EmailJsonError", {
  reason: Schema.Literals(["invalid-json", "payload-limit"]),
}) {
  override get message(): string {
    return `Email JSON parsing failed (${this.reason}).`;
  }
}

interface EmailJsonFrame {
  readonly closing: "}" | "]";
  readonly keys: Set<string>;
}

const JsonKey = Schema.fromJsonString(Schema.String);

const JsonValue = Schema.fromJsonString(Schema.Unknown);

const parseEmailJsonString = Effect.fnUntraced(function* parseEmailJsonString(
  body: string,
  start: number,
): Effect.fn.Return<{ readonly end: number; readonly key: string | undefined }, EmailJsonError> {
  let end = start + 1;

  while (end < body.length && body[end] !== '"') {
    end += body[end] === "\\" ? 2 : 1;
  }

  if (end >= body.length) {
    return yield* new EmailJsonError({ reason: "invalid-json" });
  }

  let next = end + 1;

  while (/[\u0020\n\r\t]/u.test(body[next] ?? "")) {
    next += 1;
  }

  if (body[next] !== ":") {
    return { end, key: undefined };
  }

  const key = yield* Schema.decodeEffect(JsonKey)(body.slice(start, end + 1)).pipe(
    Effect.mapError(() => new EmailJsonError({ reason: "invalid-json" })),
  );

  if (key.length > 256) {
    return yield* new EmailJsonError({ reason: "payload-limit" });
  }

  return { end, key };
});

export const parseEmailBoundedJson = Effect.fnUntraced(function* parseEmailBoundedJson(
  body: string,
): Effect.fn.Return<unknown, EmailJsonError> {
  const frames: EmailJsonFrame[] = [];
  let structuralCount = 0;
  let keyCount = 0;
  let offset = 0;

  while (offset < body.length) {
    const character = body[offset];

    if (character === '"') {
      const token = yield* parseEmailJsonString(body, offset);
      offset = token.end;

      if (token.key !== undefined) {
        const frame = frames.at(-1);

        if (frame?.closing !== "}") {
          return yield* new EmailJsonError({ reason: "invalid-json" });
        }

        keyCount += 1;

        if (keyCount > 4096) {
          return yield* new EmailJsonError({ reason: "payload-limit" });
        }

        if (frame.keys.has(token.key)) {
          return yield* new EmailJsonError({ reason: "invalid-json" });
        }

        frame.keys.add(token.key);
      }
    } else if (character !== undefined && "{}[],:".includes(character)) {
      structuralCount += 1;

      if (structuralCount > 16_384) {
        return yield* new EmailJsonError({ reason: "payload-limit" });
      }

      if (character === "{" || character === "[") {
        frames.push({ closing: character === "{" ? "}" : "]", keys: new Set() });

        if (frames.length > 32) {
          return yield* new EmailJsonError({ reason: "payload-limit" });
        }
      } else if (character === "}" || character === "]") {
        const frame = frames.pop();

        if (frame?.closing !== character) {
          return yield* new EmailJsonError({ reason: "invalid-json" });
        }
      }
    }

    offset += 1;
  }

  return yield* Schema.decodeEffect(JsonValue)(body).pipe(
    Effect.mapError(() => new EmailJsonError({ reason: "invalid-json" })),
  );
});
