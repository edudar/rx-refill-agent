import { z } from "zod";

export const pharmacyListingSchema = z.object({
  pharmacyId: z.string().min(1),
  name: z.string().min(1),
  address: z.string(),
});

export type PharmacyListing = z.infer<typeof pharmacyListingSchema>;
export interface PharmacyDirectory {
  search(query: string): Promise<PharmacyListing[]>;
}
