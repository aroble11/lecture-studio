# Printing student and teacher copies

**Print student copy** and **Print teacher copy** in **Your materials** open the browser's print window,
where the teacher can print or choose **Save as PDF**. Both print the full packet, whichever tab is open.

- The packet is built from the materials data (`app/components/PrintableMaterials.tsx`), never from what
  the screen shows. The student copy is printed from `forStudents()` in `lib/export-plan.ts`, which removes
  every answer, quiz answer and explanation, exit-ticket sample answer, the bell-ringer teacher note,
  diagram notes, pacing feedback, and content gaps. The word bank stays when the profile asks for one.
- **Student copy:** name/date/period header; guided notes with blanks and whiteboard drawings with numbered
  blanks; the label-the-picture activity; the check for understanding; then the exit ticket and the bell
  ringer on one page with a cut line.
- **Teacher copy:** the same sections with answers, the correct choices and explanations, sample answers,
  the bell-ringer note, and a final "For you: pacing and gaps" page, marked "AI-generated — review before use."
- Printing always uses the light palette, keeps the red marker colors even when the browser drops
  background graphics, and sets the page title (and so the saved PDF's name) to the handout's title and copy.
- Browsers add their own header and footer (URL, date) unless the teacher turns off **Headers and footers**
  in the print window; the screen reminds them.

Tests: `tests/export-plan.test.mjs` (nothing teacher-only reaches the student copy) and the browser test
"printing makes a student copy without answers and a teacher copy with them."
