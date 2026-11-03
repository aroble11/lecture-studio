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
  await page.getByLabel(/Key words and names/).fill("Federalism");
  await page.getByLabel(/Upload a recording/).setInputFiles({ name: "lecture.wav", mimeType: "audio/wav", buffer: toneWav(100) });
  await expect(page.getByText("lecture.wav")).toBeVisible();

  await page.getByRole("button", { name: "Transcribe lecture" }).click();
  await expect(page.getByText(/The service is busy — waiting for a free slot/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Transcript" })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText("Federalism divides power between levels of government.").first()).toBeVisible();
  expect(calls.transcribe.length).toBe(4); // two chunks, each retried once after "busy"
  expect(calls.transcribe.every((url) => url.searchParams.getAll("kw").join() === "Federalism")).toBe(true);

  await page.getByLabel(/Use open-weight model for materials/).check();
  await page.getByRole("button", { name: "Generate materials" }).click();
  await expect(page.getByRole("heading", { name: "Your materials", exact: true })).toBeVisible();
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

  const audioUpload = page.getByLabel(/Upload a recording/);
  await expect(audioUpload).toHaveAttribute("type", "file");
  const imageUpload = page.getByLabel("Choose picture");
  await expect(imageUpload).toHaveAttribute("type", "file");
  await expect(imageUpload).toHaveAccessibleDescription(/slide, worksheet, or photo/);

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
  await expect(page.getByText(/Audio is sent to Meta to be transcribed\./)).toBeVisible();
  await page.getByText("Where my data goes").click();
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
  await expect(page.getByText(/Class videos — stay in your browser/)).toBeVisible();
  await expect(page.getByText(/only the drawings you choose to keep are sent to Meta/)).toBeVisible();
});

test("theme switch overrides the browser setting and is remembered", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  const html = page.locator("html");
  await expect(page.getByRole("radio", { name: "Match browser" })).toBeChecked();

  await page.locator('label[for="theme-dark"]').click();
  await expect(html).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(html).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("radio", { name: "Dark" })).toBeChecked();

  await page.locator('label[for="theme-system"]').click();
  await expect(html).not.toHaveAttribute("data-theme", /./);
  await page.reload();
  await expect(page.getByRole("radio", { name: "Match browser" })).toBeChecked();
});

test("the sample lecture loads finished materials without calling any API", async ({ page }) => {
  const calls = await mockApi(page);
  await page.route("**/sample/sample-lecture.json", (route) => route.fulfill({
    json: {
      format: "lecture-studio-sample",
      version: 1,
      title: "Federalism sample",
      session: {
        version: 1,
        keywords: "Federalism",
        lesson: { subject: "U.S. History", grade: "10", objective: "", standards: "" },
        turns: [{ startMs: 0, endMs: 5_000, text: "Federalism divides power between levels of government." }],
        durationMs: 5_000,
        refImage: null,
        diagram: null,
        result: { materials, model: "test-model", seconds: 1 },
        resultSource: null,
        resultDiagram: null,
        privacy: false,
      },
    },
  }));
  await page.goto("/");
  await expect(page.getByRole("status").filter({ hasText: "Saved in this browser." })).toBeVisible();

  await page.getByRole("button", { name: /Try a sample lecture/ }).click();
  await expect(page.getByText(/Sample lecture: Federalism sample\./)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your materials", exact: true })).toBeVisible();
  await expect(page.getByText("Federalism Guided Notes")).toBeVisible();
  await expect(page.getByLabel("Subject")).toHaveValue("U.S. History");

  expect(calls.transcribe).toHaveLength(0);
  expect(calls.generate).toHaveLength(0);
  expect(calls.unexpected).toEqual([]);
});

test("a teacher can edit the transcript; materials are flagged as outdated and edits survive a refresh", async ({ page }) => {
  const calls = await mockApi(page);
  await page.route("**/sample/sample-lecture.json", (route) => route.fulfill({
    json: {
      format: "lecture-studio-sample", version: 1, title: "Federalism sample",
      session: {
        version: 1, keywords: "", lesson: { subject: "U.S. History", grade: "10", objective: "", standards: "" },
        turns: [{ startMs: 0, endMs: 5_000, text: "Federalism devides power between levels of government." }],
        durationMs: 5_000, refImage: null, diagram: null,
        result: { materials, model: "test-model", seconds: 1 }, resultSource: null, resultDiagram: null, privacy: false,
      },
    },
  }));
  await page.goto("/");
  await expect(page.getByRole("status").filter({ hasText: "Saved in this browser." })).toBeVisible();
  await page.getByRole("button", { name: /Try a sample lecture/ }).click();
  await expect(page.getByText("Federalism Guided Notes")).toBeVisible();

  await page.getByRole("button", { name: "Edit transcript" }).click();
  const segment = page.getByLabel(/Transcript from 0:00/);
  await segment.fill("Federalism divides power between levels of government.");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Federalism divides power between levels of government.").first()).toBeVisible();
  await expect(page.getByText(/made before you edited the transcript/)).toBeVisible();

  await expect(page.getByRole("status").filter({ hasText: "Saved in this browser." })).toBeVisible();
  await page.reload();
  await expect(page.getByText("Federalism divides power between levels of government.").first()).toBeVisible();
  await expect(page.getByText(/made before you edited the transcript/)).toBeVisible();
  expect(calls.transcribe).toHaveLength(0);
  expect(calls.generate).toHaveLength(0);
});

test("printing makes a student copy without answers and a teacher copy with them", async ({ page }) => {
  await mockApi(page);
  await page.addInitScript(() => { window.__prints = 0; window.print = () => { window.__prints += 1; }; });
  await page.route("**/sample/sample-lecture.json", (route) => route.fulfill({
    json: {
      format: "lecture-studio-sample", version: 1, title: "Federalism sample",
      session: {
        version: 1, keywords: "", lesson: { subject: "U.S. History", grade: "10", objective: "", standards: "" },
        turns: [{ startMs: 0, endMs: 5_000, text: "Federalism divides power between levels of government." }],
        durationMs: 5_000, refImage: null, diagram: null,
        result: { materials, model: "test-model", seconds: 1 }, resultSource: null, resultDiagram: null, privacy: false,
      },
    },
  }));
  await page.goto("/");
  await page.getByRole("button", { name: /Try a sample lecture/ }).click();
  await expect(page.getByText("Federalism Guided Notes").first()).toBeVisible();
  const printRoot = page.locator("#print-root");
  const teacherOnly = ["Correct 1 is stated in the lecture.", "Give students three minutes.", "Between national and state governments.", "Teacher copy", "You spent most of the time on federalism."];

  await page.getByRole("button", { name: "Print student copy" }).click();
  await expect.poll(() => page.evaluate(() => window.__prints)).toBe(1);
  await expect(printRoot).toHaveAttribute("data-copy", "student");
  await page.emulateMedia({ media: "print" });
  await expect(printRoot).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your materials" })).toBeHidden();
  await expect(printRoot).toContainText("Question 1?");
  await expect(printRoot).toContainText("Name");
  for (const text of teacherOnly) await expect(printRoot).not.toContainText(text);
  await expect(printRoot).not.toContainText("Federalism divides power", { useInnerText: true });

  await page.emulateMedia({ media: "screen" });
  await page.getByRole("button", { name: "Print teacher copy" }).click();
  await expect.poll(() => page.evaluate(() => window.__prints)).toBe(2);
  await expect(printRoot).toHaveAttribute("data-copy", "teacher");
  await page.emulateMedia({ media: "print" });
  for (const text of teacherOnly) await expect(printRoot).toContainText(text);
  await expect(printRoot).toContainText("Federalism");
});
