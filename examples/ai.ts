import { Effect } from "effect";
import { emailAiTool } from "../src/email-ai-tool.js";

export const hostAiTools = emailAiTool(Effect.runPromise).pipe(
  Effect.map((sendEmail) => ({ sendEmail })),
);
