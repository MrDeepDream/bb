import { experimental_getHostPathComparisonKey as getHostPathComparisonKey } from "@get-bb/plugin-sdk";

export function documentKeyFor(
  hostId: string | undefined,
  filePath: string,
): string {
  const canonical = getHostPathComparisonKey(filePath);
  if (canonical === null) throw new Error("File paths must be absolute");
  return `${hostId ?? "default"}::${canonical}`;
}
