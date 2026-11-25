import { z } from 'zod';

export const jobSchema = z.object({
  plantCode: z.string().trim().min(1, 'plantCode est requis'),
  injectedPower: z.coerce.number().positive('injectedPower doit être > 0'),
  address: z.string().trim().min(1, 'address est requis'),
  projectType: z.string().trim().min(1, 'projectType est requis'),
  siteName: z.string().trim().min(1, 'siteName est requis'),
  spv: z.string().trim().min(1, 'spv est requis'),
  dre: z
    .url('dre doit être une URL valide')
    .refine((u) => /^https?:\/\//i.test(u), 'dre doit être une URL http(s)'),
  // Optionnel : permet à l'appelant de forcer un arrêt avant la signature finale.
  dryRun: z.boolean().optional(),
});

export type Job = z.infer<typeof jobSchema>;
