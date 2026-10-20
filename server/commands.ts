import { z } from "zod";
import type { Settings, Point } from "../shared/protocol.js";

export const settingsSchema = z.strictObject({
  // Devnet accepts up to 1,000 entries per JSON-RPC array.
  batchSize: z.number().int().min(1).max(1000),
  concurrency: z.number().int().min(1).max(32),
}) satisfies z.ZodType<Settings>;
const pointSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
}) satisfies z.ZodType<Point>;
export const commandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("spray"), point: pointSchema }),
  z.object({ type: z.literal("stop") }),
  z.object({ type: z.literal("configure"), settings: settingsSchema }),
  z.object({ type: z.literal("reset") }),
]);
