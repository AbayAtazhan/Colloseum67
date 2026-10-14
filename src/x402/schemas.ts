import { z } from "zod";

/** Wire shape of the facilitator /verify and /settle requests (x402 v2). */
export const facilitatorRequestSchema = z.object({
  x402Version: z.number(),
  paymentPayload: z.unknown(),
  paymentRequirements: z.unknown(),
  /** SWARM TAB extension for journal correlation. */
  paymentId: z.string().nullish(),
});

export type FacilitatorRequestBody = z.infer<typeof facilitatorRequestSchema>;
