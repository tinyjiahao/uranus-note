import { z } from "zod";

const codePoints = (value: string) => Array.from(value).length;

export const emailSchema = z.string().trim().max(254, "EMAIL_INVALID")
  .regex(/^[\x21-\x7e]+$/, "EMAIL_INVALID").pipe(z.email({ error: "EMAIL_INVALID" }));
export const usernameSchema = z.string().transform((value) => value.trim().normalize("NFC"))
  .refine((value) => codePoints(value) >= 1 && codePoints(value) <= 32, "USERNAME_LENGTH")
  .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), "USERNAME_CONTROL_CHARACTER");
export const passwordSchema = z.string()
  .refine((value) => codePoints(value) >= 8 && codePoints(value) <= 128, "PASSWORD_LENGTH")
  .refine((value) => value.trim().length > 0, "PASSWORD_BLANK");

export const normalizeEmail = (email: string) => emailSchema.parse(email).toLowerCase();
export const normalizeUsername = (username: string) => usernameSchema.parse(username).toLowerCase();

export const registrationSchema = z.strictObject({
  email: emailSchema,
  username: usernameSchema.refine((value) => value.toLowerCase() !== "admin", "USERNAME_RESERVED"),
  password: passwordSchema,
  confirmPassword: z.string(),
}).refine((value) => value.password === value.confirmPassword, {
  path: ["confirmPassword"], message: "PASSWORD_CONFIRMATION_MISMATCH",
});

export const loginSchema = z.strictObject({ email: emailSchema, password: passwordSchema });
export const changeUsernameSchema = z.strictObject({ username: usernameSchema });
export const changeEmailSchema = z.strictObject({ email: emailSchema, currentPassword: passwordSchema });
export const changePasswordSchema = z.strictObject({
  currentPassword: passwordSchema, password: passwordSchema, confirmPassword: z.string(),
}).refine((value) => value.password === value.confirmPassword, {
  path: ["confirmPassword"], message: "PASSWORD_CONFIRMATION_MISMATCH",
});

export type AccountIdentity = { id: string; email: string; username: string };
