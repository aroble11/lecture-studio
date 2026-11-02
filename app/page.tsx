import LectureCapture from "./components/LectureCapture";
import Link from "next/link";

export default function Home() {
  return (
    <div className="flex flex-1 justify-center bg-zinc-50 dark:bg-black">
      <main className="w-full max-w-3xl px-4 py-12 sm:px-8">
        <header className="mb-8">
          <h1 className="text-3xl font-semibold tracking-tight">Lecture Studio</h1>
          <p className="mt-2 text-zinc-600 dark:text-zinc-400">
            Record a lecture, get classroom-ready materials.
          </p>
          <Link href="/privacy" className="mt-2 inline-block text-sm font-medium text-blue-700 underline dark:text-blue-400">
            Privacy and data flow
          </Link>
        </header>
        <LectureCapture />
      </main>
    </div>
  );
}
