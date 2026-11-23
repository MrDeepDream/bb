import { describe, expect, it } from "vitest";
import { isFileMetafileInput } from "./metafile-inputs.js";

describe("isFileMetafileInput", () => {
  it.each([
    ["a relative path", "src/server.ts"],
    ["a parent-relative path", "../shared/server.ts"],
    ["a POSIX absolute path", "/home/dev/plugin/server.ts"],
    ["an uppercase Windows drive path", "C:/Users/dev/plugin/server.ts"],
    ["a lowercase Windows drive path", "d:/plugin/server.ts"],
    ["a colon later in the path", "src/a:b/server.ts"],
  ])("accepts %s", (_label, input) => {
    expect(isFileMetafileInput(input)).toBe(true);
  });

  it.each([
    ["a plugin namespace", "bb-runtime:x"],
    ["the Zod locale namespace", "bb-zod-locale-stub:zod/v4/locales/en.js"],
    ["a data URL", "dataurl:data:text/javascript,export default 1"],
    ["a disabled module", "(disabled):fs"],
  ])("rejects %s", (_label, input) => {
    expect(isFileMetafileInput(input)).toBe(false);
  });
});
