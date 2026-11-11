export const DURATIONS = [40, 60, 80, 100, 120] as const;

// Preserve the original ArugoBot formula, including the 160-point cap.
export function ratingChanges(rating: number, problemRating: number, minutes: number): [number, number] {
  const adjusted = problemRating + 50 * ((80 - minutes) / 20);
  const power = 10 ** ((adjusted - rating) / 500);
  return [
    -Math.min(160, Math.floor(8 / (1 - 1 / (1 + power)))),
    Math.min(160, Math.floor(8 / (1.15 / (1 + power)))),
  ];
}

export function ratingColor(rating: number): number {
  if (rating < 1200) return 0x808080;
  if (rating < 1400) return 0x008000;
  if (rating < 1600) return 0x03a89e;
  if (rating < 1900) return 0x0000ff;
  if (rating < 2100) return 0xaa00aa;
  if (rating < 2300) return 0xffcc00;
  if (rating < 2400) return 0xff8800;
  if (rating < 2600) return 0xff0000;
  if (rating < 3000) return 0xff69b4;
  return 0xff0000;
}
