// End-to-end browser checks with every API response mocked: no provider calls, no credits spent.
import { expect, test } from "@playwright/test";

/** Mono PCM16 WAV: a quiet tone the browser can decode, long enough to plan into two chunks. */
function toneWav(seconds, rate = 24_000) {
  const samples = seconds * rate;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + samples * 2, 4);
  wav.write("WAVEfmt ", 8, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * 3000), 44 + i * 2);
  return wav;
}

/** A complete materials result that passes the app's own validation when restored. */
const materials = {
  guidedNotes: {
    title: "Federalism Guided Notes",
    sections: [{ heading: "Dividing power", startSec: 0, items: [{ text: "_____ divides power between levels of government.", answer: "Federalism" }] }],
    wordBank: [],
  },
  quiz: Array.from({ length: 5 }, (_, i) => ({
    question: `Question ${i + 1}?`,
    choices: [`Correct ${i + 1}`, `Wrong ${i + 1}A`, `Wrong ${i + 1}B`, `Wrong ${i + 1}C`],
    answerIndex: 0,
    explanation: `Correct ${i + 1} is stated in the lecture.`,
  })),
  exitTicket: [{ question: "How is power divided?", sampleAnswer: "Between national and state governments." }],
  bellRinger: { prompt: "Name two levels of government.", teacherNote: "Give students three minutes." },
  diagramNotes: [],
  pacingFeedback: ["You spent most of the time on federalism."],
  contentGaps: [],
};

/** Mock every /api route; anything unexpected fails the test instead of reaching a server. */
async function mockApi(page) {
  const calls = { transcribe: [], generate: [], unexpected: [] };
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/transcribe") {
      calls.transcribe.push(url);
      // Both chunks' first attempts are told the service is busy, so the wait-and-retry path and
      // its message are exercised (one success would end the pause early, by design).
      if (calls.transcribe.length <= 2) {
        return route.fulfill({ status: 429, headers: { "Retry-After": "1" }, json: { reason: "busy", error: "The service is busy." } });
      }
      return route.fulfill({ json: { turns: [{ startMs: 0, endMs: 5_000, text: "federalism divides power between levels of government." }] } });
    }
    if (url.pathname === "/api/generate") {
      const body = route.request().postDataJSON();
      calls.generate.push(body);
      return route.fulfill({ json: { materials, model: "test-model", seconds: 1, ...(body.privacy ? { privacy: true } : {}) } });
    }
    calls.unexpected.push(url.pathname);
    return route.abort();
  });
  return calls;
}

test("upload, transcribe, generate, and restore the lecture after a refresh", async ({ page }) => {
  const calls = await mockApi(page);
  await page.goto("/");
  await expect(page.getByRole("status").filter({ hasText: "Saved in this browser." })).toBeVisible();

  await page.getByLabel("Subject").fill("U.S. History");
  await page.getByLabel(/Key vocabulary/).fill("Federalism");
  await page.getByLabel("Upload audio").setInputFiles({ name: "lecture.wav", mimeType: "audio/wav", buffer: toneWav(100) });
  await expect(page.getByText("lecture.wav")).toBeVisible();

  await page.getByRole("button", { name: "Transcribe lecture" }).click();
  await expect(page.getByText(/The service is busy — waiting for a free slot/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Transcript" })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText("Federalism divides power between levels of government.").first()).toBeVisible();
  expect(calls.transcribe.length).toBe(4); // two chunks, each retried once after "busy"
  expect(calls.transcribe.every((url) => url.searchParams.getAll("kw").join() === "Federalism")).toBe(true);

  await page.getByLabel(/Use open-weight model for materials/).check();
  await page.getByRole("button", { name: "Generate materials" }).click();
  await expect(page.getByRole("heading", { name: "Materials", exact: true })).toBeVisible();
  await expect(page.getByText("Federalism Guided Notes")).toBeVisible();
  await expect(page.getByText("Open-weight generation")).toBeVisible();
  expect(calls.generate).toHaveLength(1);
  expect(calls.generate[0].privacy).toBe(true);
  expect(calls.generate[0].context).toMatchObject({ subject: "U.S. History", vocabulary: ["Federalism"] });
  expect(calls.generate[0].turns).toHaveLength(2);

  await expect(page.getByRole("status").filter({ hasText: "Saved in this browser." })).toBeVisible();
  await page.reload();
  await expect(page.getByText("Federalism Guided Notes")).toBeVisible();
  await expect(page.getByText("Federalism divides power between levels of government.").first()).toBeVisible();
  await expect(page.getByLabel("Subject")).toHaveValue("U.S. History");
  await expect(page.getByText("lecture.wav")).toBeVisible();
  await expect(page.getByRole("button", { name: "Regenerate" })).toBeVisible();
  expect(calls.transcribe.length + calls.generate.length).toBe(5); // restoring made no API calls

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Start over" }).click();
  await expect(page.getByRole("heading", { name: "Transcript" })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("status").filter({ hasText: "Saved in this browser." })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Transcript" })).toHaveCount(0);
  await expect(page.getByLabel("Subject")).toHaveValue("");
  expect(calls.unexpected).toEqual([]);
});

test("file upload controls are named, described, and reachable by keyboard", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await expect(page.getByRole("status").filter({ hasText: "Saved in this browser." })).toBeVisible();

  const audioUpload = page.getByLabel("Upload audio");
  await expect(audioUpload).toHaveAttribute("type", "file");
  const imageUpload = page.getByLabel("Add image");
  await expect(imageUpload).toHaveAttribute("type", "file");
  await expect(imageUpload).toHaveAccessibleDescription(/a slide, worksheet, diagram, or photo/);

  for (const control of [audioUpload, imageUpload]) {
    await page.locator("body").focus();
    let reached = false;
    for (let i = 0; i < 40 && !reached; i++) {
      await page.keyboard.press("Tab");
      reached = await control.evaluate((element) => element === document.activeElement);
    }
    expect(reached).toBe(true);
  }
});

test("data-flow disclosures appear before upload and on the privacy page", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await expect(page.getByText("Audio chunks and key vocabulary go to Meta for transcription.")).toBeVisible();
  await expect(page.getByText(/the open-weight option sends that generation step to Baseten instead/)).toBeVisible();
  await expect(page.getByText("Privacy Mode")).toHaveCount(0);

  await page.getByRole("link", { name: "Privacy and data flow" }).first().click();
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.getByRole("heading", { name: "Usage limits on the server" })).toBeVisible();
  await expect(page.getByText(/never the address itself/)).toBeVisible();
  await expect(page.getByText(/does not make claims about provider retention, district approval, or legal compliance/)).toBeVisible();
  await expect(page.getByText(/deletes the saved teaching profile/)).toBeVisible();
  await expect(page.getByText(/Audio over 100 MB/)).toBeVisible();
});
