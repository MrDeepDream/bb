import { experimental_getHostPathBasename as getHostPathBasename } from "@get-bb/plugin-sdk";

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  vue: "html",
  svelte: "html",

  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  ini: "ini",
  properties: "ini",
  cfg: "ini",
  conf: "ini",
  env: "shell",
  xml: "xml",
  csv: "plaintext",
  tsv: "plaintext",

  md: "markdown",
  mdx: "markdown",
  markdown: "markdown",
  txt: "plaintext",
  text: "plaintext",
  rst: "plaintext",
  adoc: "plaintext",

  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  rs: "rust",
  go: "go",
  zig: "plaintext",
  swift: "swift",
  m: "objective-c",
  mm: "objective-c",

  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  scala: "scala",
  groovy: "plaintext",
  cs: "csharp",
  fs: "fsharp",

  py: "python",
  pyi: "python",
  rb: "ruby",
  php: "php",
  pl: "perl",
  lua: "lua",
  r: "r",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  ps1: "powershell",
  bat: "bat",
  cmd: "bat",

  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  proto: "plaintext",

  tf: "hcl",
  tfvars: "hcl",
  hcl: "hcl",
  dockerfile: "dockerfile",

  dart: "dart",
  ex: "plaintext",
  exs: "plaintext",
  erl: "plaintext",
  clj: "clojure",
  hs: "plaintext",
  jl: "julia",
  patch: "plaintext",
  diff: "plaintext",
  log: "plaintext",
};

const LANGUAGE_BY_DOTFILE: Record<string, string> = {
  env: "shell",
  envrc: "shell",
  bashrc: "shell",
  zshrc: "shell",
  gitignore: "plaintext",
  gitattributes: "plaintext",
  gitmodules: "ini",
  dockerignore: "plaintext",
  npmignore: "plaintext",
  eslintignore: "plaintext",
  prettierignore: "plaintext",
  editorconfig: "ini",
  npmrc: "ini",
  nvmrc: "plaintext",
};

const PREVIEW_RENDERED_EXTENSIONS = new Set(["md", "markdown", "html", "htm"]);

export const CLAIMED_EXTENSIONS: readonly string[] = [
  ...new Set([
    ...Object.keys(LANGUAGE_BY_EXTENSION).filter(
      (extension) => !PREVIEW_RENDERED_EXTENSIONS.has(extension),
    ),
    ...Object.keys(LANGUAGE_BY_DOTFILE),
  ]),
];

function fileNameForPath(path: string): string {
  return getHostPathBasename(path) ?? path.split("/").at(-1) ?? path;
}

function extensionOfName(name: string): string {
  const dotIndex = name.lastIndexOf(".");
  return dotIndex <= 0 ? "" : name.slice(dotIndex + 1).toLowerCase();
}

function dotfileLanguage(name: string): string | undefined {
  if (!name.startsWith(".")) return undefined;
  const dotfile = name.slice(1).toLowerCase();
  return dotfile.startsWith("env.") ? "shell" : LANGUAGE_BY_DOTFILE[dotfile];
}

export function fileExtensionForPath(path: string): string {
  return extensionOfName(fileNameForPath(path));
}

export function languageForPath(path: string): string {
  const name = fileNameForPath(path);
  return (
    LANGUAGE_BY_EXTENSION[extensionOfName(name)] ??
    dotfileLanguage(name) ??
    "plaintext"
  );
}
