/** Server-side emergency switch, checked before reading uploads or contacting a provider.
 * Unset preserves existing behavior; an invalid value stops paid work rather than silently enabling it.
 * Environment changes on Vercel require a new deployment. This does not cancel work already running.
 */
export function paidProcessingUnavailable(): Response | null {
  const setting = process.env.PAID_PROCESSING_ENABLED?.trim().toLowerCase();
  if (setting === undefined || setting === "true") return null;

  return Response.json(
    { error: "Audio processing and AI generation are temporarily paused. Your saved materials are still available." },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}
