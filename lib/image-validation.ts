import sharp from "sharp";
import { LABELING } from "@/lib/config";
import { InputError } from "@/lib/input-validation";

/** Validate the actual image, not just a MIME label or a permissive base64 decode. */
export async function validateImage(value: unknown): Promise<string> {
  if (typeof value !== "string" || value.length > LABELING.maxBodyBytes) throw new InputError("image must be a bounded base64 data URL");
  const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw new InputError("image must be a JPEG, PNG, or WebP base64 data URL");
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.toString("base64") !== match[2]) throw new InputError("image contains invalid base64");
  const actual = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "png"
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? "jpeg"
    : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" ? "webp" : "unknown";
  if (actual !== match[1]) throw new InputError("Image contents do not match the declared format");
  try {
    const decoder = sharp(bytes, { limitInputPixels: LABELING.maxImageSide ** 2, failOn: "warning" });
    const meta = await decoder.metadata();
    if (!meta.width || !meta.height || meta.width > LABELING.maxImageSide || meta.height > LABELING.maxImageSide ||
        (meta.pages ?? 1) !== 1 || meta.format !== actual) {
      throw new InputError(`Use a single-frame image no larger than ${LABELING.maxImageSide} × ${LABELING.maxImageSide} pixels`);
    }
    await decoder.raw().toBuffer(); // Metadata alone does not prove the pixel data is decodable.
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError(`Image is damaged, unsupported, or exceeds ${LABELING.maxImageSide} × ${LABELING.maxImageSide} pixels`);
  }
  return value;
}
