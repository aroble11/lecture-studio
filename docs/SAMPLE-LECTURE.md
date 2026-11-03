# The sample lecture

**Try a sample lecture** loads `public/sample/sample-lecture.json`: a reviewed lecture with its transcript,
any picture and whiteboard drawings, and finished materials. Loading it makes no provider calls, asks before
replacing the teacher's current lecture, and shows a "Sample lecture" banner. The file is checked with the
same rules as a saved lecture (`lib/sample-lecture.ts`) and must contain finished materials. An optional
recording (`public/sample/sample-lecture.m4a`, `.mp3`, `.wav`, `.webm`, or `.ogg`) can sit beside it.

## Making or replacing the sample

1. Run `npm run dev` and open http://localhost:3000. Select **Start over**.
2. Add the lecture (a recording or class video), lesson details, any picture, and keep the whiteboard
   moments you want. Transcribe, review and edit the transcript, generate, and fix any labels. Use
   standard (Meta) generation so the sample shows the most complete output.
3. In the browser's DevTools console on that page, copy the saved lecture out (it reads only, and leaves
   out the audio):

   ```js
   const db = await new Promise((ok, err) => { const r = indexedDB.open("lecture-studio"); r.onsuccess = () => ok(r.result); r.onerror = () => err(r.error); });
   const s = await new Promise((ok, err) => { const r = db.transaction("session").objectStore("session").get("current"); r.onsuccess = () => ok(r.result); r.onerror = () => err(r.error); });
   db.close();
   const { audio, audioRevision, ...session } = s;
   const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([JSON.stringify(session)], { type: "application/json" })), download: "sample-session.json" });
   a.click();
   ```

4. Move `sample-session.json` into `test-video/` (ignored by Git), then run:

   ```powershell
   node scripts/make-sample.mjs test-video/sample-session.json --audio test-video/<recording>.m4a
   ```

   `--audio` is optional (a class video's sound must first be saved as an audio file). `--title` overrides
   the title, which defaults to the guided-notes title. The script removes the teacher-profile guidance
   (style and class notes) because the file is public, checks the result, and prints a summary.
5. Reload, select **Try a sample lecture**, review everything a judge or visitor will see, then commit
   `public/sample/`.

The sample is public on the deployed site and in the repository: use only content you are comfortable
sharing, and never students' voices, faces, or names.
