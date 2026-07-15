import { z } from "zod";

export const uuidSchema = z.string().uuid();

export const reserveTicketsSchema = z.object({
  eventId: uuidSchema,
  items: z
    .array(
      z.object({
        tierId: uuidSchema,
        quantity: z.number().int().min(1).max(20),
      })
    )
    .min(1)
    .max(10),
  promoCode: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .optional()
    .nullable(),
});

export const waitlistJoinSchema = z.object({
  eventId: uuidSchema,
  tierId: uuidSchema,
});

// Real tokens are ~71 chars ('TKT1.' + 22-char id segment + '.' + 43-char mac
// segment, see issue_ticket_qr_token in 0011_phase3_qr_realtime.sql). 200 is
// a generous cap that still rejects obviously-garbage/oversized input before
// it ever reaches the check_in_ticket() RPC.
export const checkinSchema = z.object({
  token: z.string().trim().min(1).max(200),
});

export type ReserveTicketsInput = z.infer<typeof reserveTicketsSchema>;
export type WaitlistJoinInput = z.infer<typeof waitlistJoinSchema>;
export type CheckinInput = z.infer<typeof checkinSchema>;
