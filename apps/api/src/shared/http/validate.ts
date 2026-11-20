import type { z } from "zod";
import { Errors } from "../errors/app-error.js";

/** Parses untrusted input with a Zod schema; returns typed data or throws a 400 with field issues. */
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw Errors.validation({
      issues: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return result.data;
}
