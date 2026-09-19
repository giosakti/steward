import { z } from 'zod';

const nonblank = (label: string) =>
  z
    .string()
    .refine((value) => value.trim().length > 0, `${label} must not be blank`);

export const createWorkspaceSchema = z.strictObject({
  slug: z
    .string()
    .regex(
      /^[a-z0-9]+(-[a-z0-9]+)*$/,
      'Use a lowercase slug with letters, numbers, and single hyphens',
    ),
  name: nonblank('Workspace name'),
  description: z.string().optional(),
  rootPath: nonblank('Root path').optional(),
});

export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;

export const setMissionSchema = z.strictObject({
  statement: z.string().trim().min(1).max(10000),
});

export type SetMissionInput = z.infer<typeof setMissionSchema>;

export const configureAgentSchema = z
  .strictObject({
    name: nonblank('Agent name').optional(),
    title: nonblank('Agent title').optional(),
    roleDescription: z.string().optional(),
  })
  .refine(
    (input) => Object.values(input).some((value) => value !== undefined),
    'Provide --name, --title, or --role-description',
  );

export type ConfigureAgentInput = z.infer<typeof configureAgentSchema>;
