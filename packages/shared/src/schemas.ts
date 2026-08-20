import { z } from 'zod';
import { ACTION_IDS, SHOP_ITEM_IDS } from './actions.js';
import { OCCUPATION_IDS, PERSONALITY_IDS, SPECIES_IDS } from './reference.js';
import { isCountryCode } from './countries.js';
import {
  BIO_MAX,
  BIO_MAX_NEWLINES,
  CITY_MAX,
  NICKNAME_MAX,
  NICKNAME_MIN,
  countNewlines,
  isAllowedName,
  sanitizeBio,
  sanitizeName,
} from './text.js';
import { USERNAME_PROBLEM_MESSAGES, checkUsername } from './username.js';
import { PASSWORD_MAX, PASSWORD_PROBLEM_MESSAGES, checkPassword } from './password.js';

export const usernameSchema = z
  .string()
  .max(64)
  .superRefine((value, ctx) => {
    const problem = checkUsername(value);
    if (problem) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: USERNAME_PROBLEM_MESSAGES[problem] });
    }
  });

export const registerSchema = z
  .object({
    username: usernameSchema,
    password: z.string().max(PASSWORD_MAX),
  })
  .superRefine((value, ctx) => {
    const problem = checkPassword(value.password, value.username);
    if (problem) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['password'],
        message: PASSWORD_PROBLEM_MESSAGES[problem],
      });
    }
  });

export const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(PASSWORD_MAX),
});

const nicknameSchema = z
  .string()
  .max(200)
  .transform(sanitizeName)
  .superRefine((value, ctx) => {
    if (value.length < NICKNAME_MIN || value.length > NICKNAME_MAX) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Nickname must be ${NICKNAME_MIN}-${NICKNAME_MAX} characters.`,
      });
      return;
    }
    if (!isAllowedName(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Nickname can use letters, numbers, spaces, ' and - only.",
      });
    }
  });

const bioSchema = z
  .string()
  .max(2000)
  .transform(sanitizeBio)
  .superRefine((value, ctx) => {
    if (value.length > BIO_MAX) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Bio must be ${BIO_MAX} characters or fewer.` });
    }
    if (countNewlines(value) > BIO_MAX_NEWLINES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Bio can have at most ${BIO_MAX_NEWLINES} line breaks.`,
      });
    }
  });

const citySchema = z
  .string()
  .max(200)
  .transform(sanitizeName)
  .superRefine((value, ctx) => {
    if (value.length === 0) return;
    if (value.length > CITY_MAX) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `City must be ${CITY_MAX} characters or fewer.` });
      return;
    }
    if (!isAllowedName(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "City can use letters, numbers, spaces, ' and - only.",
      });
    }
  })
  .transform((value) => (value.length === 0 ? null : value));

const countrySchema = z
  .string()
  .transform((value) => value.trim().toUpperCase())
  .refine(isCountryCode, { message: 'Pick a country from the list.' });

export const characterCreateSchema = z.object({
  speciesId: z.enum(SPECIES_IDS),
  nickname: nicknameSchema,
  bio: bioSchema.optional().default(''),
  originCountry: countrySchema,
  originCity: citySchema.nullable().optional().default(null),
  occupationId: z.enum(OCCUPATION_IDS),
  personalityId: z.enum(PERSONALITY_IDS),
});

export const characterPatchSchema = z
  .object({
    nickname: nicknameSchema,
    bio: bioSchema,
    originCountry: countrySchema,
    originCity: citySchema.nullable(),
    occupationId: z.enum(OCCUPATION_IDS),
    personalityId: z.enum(PERSONALITY_IDS),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update.' });

export const usernameAvailabilityQuerySchema = z.object({
  username: z.string().max(64),
});

export const actionParamsSchema = z.object({
  action: z.enum(ACTION_IDS),
});

export const actionRequestSchema = z
  .object({
    itemId: z.enum(SHOP_ITEM_IDS).nullish(),
  })
  .strict()
  .nullish()
  .transform((value) => ({ itemId: value?.itemId ?? null }));

export type RegisterInput = z.input<typeof registerSchema>;
export type LoginInput = z.input<typeof loginSchema>;
export type CharacterCreateInput = z.input<typeof characterCreateSchema>;
export type CharacterCreate = z.output<typeof characterCreateSchema>;
export type CharacterPatchInput = z.input<typeof characterPatchSchema>;
export type CharacterPatch = z.output<typeof characterPatchSchema>;
export type ActionParams = z.output<typeof actionParamsSchema>;
export type ActionRequestInput = z.input<typeof actionRequestSchema>;
export type ActionRequestBody = z.output<typeof actionRequestSchema>;
