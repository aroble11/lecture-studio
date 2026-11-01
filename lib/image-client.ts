// Browser-only: shrink a photo or screenshot before upload so it stays under Vercel's 4.5 MB body limit.
import { LABELING } from "./config";

export type PreparedImage = { dataUrl: string; width: number; height: number };

/** Decode (honoring phone EXIF rotation), scale the longest side to maxSide, re-encode as JPEG on white. */
export async function prepareImage(file: Blob, maxSide: number = LABELING.maxImageSide): Promise<PreparedImage> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext("2d");
  if (!g) throw new Error("This browser can't process images.");
  g.fillStyle = "#fff"; // transparent PNGs would otherwise turn black as JPEG
  g.fillRect(0, 0, width, height);
  g.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  let quality = 0.88;
  let dataUrl = canvas.toDataURL("image/jpeg", quality);
  while (dataUrl.length > LABELING.maxBodyBytes * 0.9 && quality > 0.5) {
    quality -= 0.1;
    dataUrl = canvas.toDataURL("image/jpeg", quality);
  }
  return { dataUrl, width, height };
}
