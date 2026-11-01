export function add(a: number, b: number): number {
  return a + b;
}

export const isPositive = (value: number): boolean => value > 0;

export const describeStatus = (status: string): string => `status: ${status}`;
