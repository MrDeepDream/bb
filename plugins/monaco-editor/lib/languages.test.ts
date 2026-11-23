import { describe, expect, it } from "vitest";
import { CLAIMED_EXTENSIONS, languageForPath } from "./languages.js";

describe("CLAIMED_EXTENSIONS", () => {
  it.each(["md", "markdown", "html", "htm"])(
    "leaves .%s files to bb's rendered preview",
    (extension) => {
      expect(CLAIMED_EXTENSIONS).not.toContain(extension);
    },
  );

  it("keeps code files available in the editor", () => {
    expect(CLAIMED_EXTENSIONS).toEqual(
      expect.arrayContaining([
        "mdx",
        "ts",
        "json",
        "txt",
        "vue",
        "svelte",
        "properties",
      ]),
    );
  });

  it("still highlights Markdown opened from the file tree", () => {
    expect(languageForPath("docs/guide.md")).toBe("markdown");
    expect(languageForPath("README.markdown")).toBe("markdown");
  });
});

describe("languageForPath", () => {
  it.each(["properties", "PROPERTIES", "ini", "toml", "cfg", "conf"])(
    "highlights .%s configuration files as INI",
    (extension) => {
      expect(languageForPath(`config/settings.${extension}`)).toBe("ini");
    },
  );

  it.each([
    ["a Windows dotfile", "C:\\repo\\.toml", "plaintext"],
    ["a UNC dotfile", "\\\\server\\share\\.ini", "plaintext"],
    ["a mixed-separator dotfile", "C:\\repo/conf\\.ini", "plaintext"],
    ["a Windows file", "C:\\repo\\src\\main.ts", "typescript"],
    ["a POSIX dotfile", "/home/me/.toml", "plaintext"],
    ["a POSIX name with a backslash", "/home/me/odd\\.toml", "ini"],
    ["a relative name with a backslash", "src/odd\\.toml", "ini"],
  ])("reads the file name of %s", (_name, path, language) => {
    expect(languageForPath(path)).toBe(language);
  });

  it.each([
    [".env", "shell"],
    [".ENV", "shell"],
    [".env.local", "shell"],
    [".env.production.local", "shell"],
    ["config/.env.test", "shell"],
    ["C:\\repo\\.env", "shell"],
    ["C:\\repo\\.env.local", "shell"],
    ["/home/me/.env", "shell"],
    ["sample.env", "shell"],
    [".env.json", "json"],
    [".envelope", "plaintext"],
    [".gitignore", "plaintext"],
    ["C:\\repo\\.gitignore", "plaintext"],
    [".editorconfig", "ini"],
  ])("gives %s the language %s", (path, language) => {
    expect(languageForPath(path)).toBe(language);
  });

  it.each(["env", "gitignore", "dockerignore", "editorconfig"])(
    "claims the dotfile name .%s",
    (name) => {
      expect(CLAIMED_EXTENSIONS).toContain(name);
    },
  );
});
