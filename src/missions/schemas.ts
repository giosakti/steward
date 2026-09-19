import { z } from 'zod';

export const setMissionSchema = z.strictObject({
  statement: z.string().trim().min(1).max(10000),
});

export type SetMissionInput = z.infer<typeof setMissionSchema>;
