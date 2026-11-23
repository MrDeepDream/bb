const NAMESPACED_INPUT = /^[\w-]{2,}:/u;

export function isFileMetafileInput(input: string): boolean {
  return !input.startsWith("(") && !NAMESPACED_INPUT.test(input);
}
