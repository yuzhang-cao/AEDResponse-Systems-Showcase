import { z } from "zod";
import { aedSchema, isoDateSchema } from "./contracts.js";

export const aedAssetSchema = z.object({
  aedId: z.string().min(1),
  status: z.enum(["AVAILABLE", "RESERVED", "IN_USE", "AWAITING_HANDOFF", "DEPOSITED", "AWAITING_RETURN", "UNAVAILABLE", "MAINTENANCE", "RETIRED"]),
  updatedAt: isoDateSchema,
  revision: z.number().int().nonnegative(),
  registration: z.object({
    aed: aedSchema, source: z.string().min(1).max(1000), permission: z.string().min(1).max(1000),
    maintenanceOwner: z.string().min(1).max(300), verifiedAt: isoDateSchema, validUntil: isoDateSchema
  }).strict().optional(),
  /**
   * Who physically holds the device, and since when.
   *
   * `acquiredAt` is when it left its cabinet and never changes; `custodySince` is
   * when the CURRENT holder took it, which a completed handover rewrites.  Keeping
   * them apart is what lets the record show a device that changed hands three
   * times without losing when it was first taken.
   */
  custody: z.object({ eventId: z.string().min(1), userId: z.string().min(1).optional(),
    deviceInstanceId: z.string().min(1).optional(), acquiredAt: isoDateSchema.optional(),
    custodySince: isoDateSchema.optional(), depositedAt: isoDateSchema.optional() }).strict().optional(),
  temporaryPointId: z.string().optional()
}).strict();
export type AedAssetRecord = z.infer<typeof aedAssetSchema>;
