import { z } from "zod";

export const ReceiptExtractionSchema = z.object({
  type: z.enum(["income", "expense"]).default("expense"),
  amount: z.coerce
    .number()
    .int("Nominal harus berupa bilangan bulat rupiah")
    .positive("Nominal harus lebih dari 0"),
  merchant: z.string().trim().nullable().optional().default("Tidak diketahui"),
  category: z.string().trim().default("Lain-lain"),
  note: z.string().trim().nullable().optional().default(""),
  occurred_at: z.string().trim().nullable().optional(),
});

export type ReceiptExtraction = z.infer<typeof ReceiptExtractionSchema>;
