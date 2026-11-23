import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  DEFAULT_SEARCH_MATCHES,
  MAX_FINGERPRINT_PATHS,
  searchOptionsSchema,
  searchPageSchema,
} from "./host-contract.js";

export const sourceSchema = z
  .object({
    kind: z.enum(["workspace", "host", "thread-storage"]),
    threadId: z.string().nullable(),
    environmentId: z.string().nullable(),
    projectId: z.string().nullable(),
    experimental_hostId: z.string().optional(),
  })
  .strict();

export const fileSchema = z
  .object({ path: z.string().min(1), source: sourceSchema })
  .strict();

export const searchRequestSchema = searchOptionsSchema.extend({
  limit: searchOptionsSchema.shape.limit.default(DEFAULT_SEARCH_MATCHES),
  file: fileSchema,
});

const searchIdSchema = z
  .string()
  .regex(/^[0-9a-f-]{36}:[^\0]{1,256}$/u, "Invalid search id");

export const searchStartOutputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("started"),
    searchId: z.string(),
    root: z.string(),
    hostId: z.string(),
    environmentId: z.string().nullable(),
  }),
  z.object({ kind: z.literal("unavailable"), reason: z.string() }),
]);

export const GIT_MARKERS_CHANNEL = "git-markers";

export const gitMarkerStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("patch"), patch: z.string().min(1) }),
  z.object({ kind: z.literal("clean") }),
  z.object({ kind: z.literal("deferred") }),
  z.object({ kind: z.literal("unavailable") }),
]);

export type GitMarkerState = z.infer<typeof gitMarkerStateSchema>;

export const rpcContract = defineRpcContract({
  gitMarkers: {
    input: z
      .object({ documents: z.array(fileSchema).max(MAX_FINGERPRINT_PATHS) })
      .strict(),
    output: z.object({
      states: z.record(z.string(), gitMarkerStateSchema),
    }),
  },
  searchStart: {
    input: searchRequestSchema,
    output: searchStartOutputSchema,
  },
  searchNext: {
    input: z.object({ searchId: searchIdSchema }).strict(),
    output: searchPageSchema,
  },
  searchCancel: {
    input: z.object({ searchId: searchIdSchema }).strict(),
    output: z.null(),
  },
  assets: {
    input: z.null(),
    output: z.object({ baseUrl: z.string(), expiresAtMs: z.number() }),
  },
  read: {
    input: fileSchema,
    output: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("text"),
        content: z.string(),
        sha256: z.string(),
        absolutePath: z.string(),
        relativePath: z.string(),
        documentKey: z.string(),
        hostId: z.string().nullable(),
        readOnly: z.boolean(),
        fingerprint: z.string().nullable(),
      }),
      z.object({ kind: z.literal("unsupported"), reason: z.string() }),
    ]),
  },
  tree: {
    input: fileSchema,
    output: z.object({
      root: z.string(),
      hostId: z.string().nullable(),
      environmentId: z.string().nullable(),
      entries: z.array(
        z.object({
          path: z.string(),
          kind: z.enum(["file", "directory"]),
        }),
      ),
      truncated: z.boolean(),
    }),
  },
  write: {
    input: fileSchema.extend({
      content: z.string(),
      expectedSha256: z.string().min(1).nullable(),
    }),
    output: z.discriminatedUnion("outcome", [
      z.object({ outcome: z.literal("written"), sha256: z.string() }),
      z.object({
        outcome: z.literal("conflict"),
        currentSha256: z.string().nullable(),
      }),
    ]),
  },
  documentFingerprints: {
    input: z
      .object({ documents: z.array(fileSchema).max(MAX_FINGERPRINT_PATHS) })
      .strict(),
    output: z.object({
      fingerprints: z.record(z.string(), z.string().nullable()),
      rootTags: z.array(z.string()),
    }),
    tags: (_input, output) => output.rootTags,
  },
});
