import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const MAX_FINGERPRINT_PATHS = 256;

export const MAX_SEARCH_QUERY_CHARS = 1_000;

export const MAX_SEARCH_MATCHES = 20_000;

export const DEFAULT_SEARCH_MATCHES = 2_000;

export const searchOptionsSchema = z
  .object({
    query: z
      .string()
      .min(1)
      .max(MAX_SEARCH_QUERY_CHARS)
      .refine((value) => !/[\0\r\n]/u.test(value), {
        message: "The query must be a single line",
      }),
    mode: z.enum(["literal", "regex"]),
    caseSensitive: z.boolean(),
    limit: z.number().int().min(1).max(MAX_SEARCH_MATCHES),
  })
  .strict();

export const searchPageSchema = z.object({
  status: z.enum(["running", "done", "expired"]),
  files: z.array(
    z.object({
      path: z.string(),
      matches: z.array(
        z.object({
          line: z.number().int().positive(),
          column: z.number().int().positive(),
          matchStart: z.number().int().nonnegative(),
          text: z.string(),
        }),
      ),
    }),
  ),
  matchCount: z.number().int().nonnegative(),
  truncated: z.enum(["limit", "bytes", "time"]).nullable(),
  error: z.string().nullable(),
});

export type SearchOptions = z.infer<typeof searchOptionsSchema>;

export type SearchPage = z.infer<typeof searchPageSchema>;

export const monacoHostContract = defineRpcContract({
  searchStart: {
    input: searchOptionsSchema.extend({ rootPath: z.string().min(1) }),
    output: z.object({ searchId: z.uuid() }),
  },
  searchNext: {
    input: z.object({ searchId: z.uuid() }).strict(),
    output: searchPageSchema,
  },
  searchCancel: {
    input: z.object({ searchId: z.uuid() }).strict(),
    output: z.null(),
  },
  fingerprints: {
    input: z
      .object({
        paths: z.array(z.string().min(1)).min(1).max(MAX_FINGERPRINT_PATHS),
      })
      .strict(),
    output: z.record(z.string(), z.string().nullable()),
  },
  isRepositoryRoot: {
    input: z.object({ rootPath: z.string().min(1) }).strict(),
    output: z.boolean(),
  },
  watchRoot: {
    input: z.object({ rootPath: z.string().min(1) }).strict(),
    output: z.null(),
  },
  unwatchRoot: {
    input: z.object({ rootPath: z.string().min(1) }).strict(),
    output: z.null(),
  },
});

export const monacoHostSignals = {
  rootChanged: {
    payload: z.object({ rootPath: z.string().min(1) }).strict(),
  },
} as const;
