import type { Metadata } from "next";
import localFont from "next/font/local";
import { GeistMono } from "geist/font/mono";
import { THEME_KEY } from "@/lib/theme";
import "./globals.css";

// Applies a saved Light/Dark choice before first paint (see the Next.js "Preventing flash before hydration" guide).
const themeScript = `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}})()`;

// Nunito (SIL Open Font License, see ./fonts/Nunito-OFL.txt) is bundled so builds never fetch fonts.
const nunito = localFont({
  src: "./fonts/nunito-latin-wght-normal.woff2",
  variable: "--font-nunito",
  weight: "200 1000",
  display: "swap",
});

const description = "Lecture in, handouts out: guided notes, quizzes, and review built from what you actually said in class.";

// The share image and icons are files in app/ (opengraph-image.png, twitter-image.png, icon.svg, apple-icon.png,
// favicon.ico); metadataBase turns their paths into the absolute URLs that link previews require.
export const metadata: Metadata = {
  metadataBase: new URL("https://lecture-studio-nine.vercel.app"),
  title: "Lecture Studio",
  description,
  openGraph: { type: "website", siteName: "Lecture Studio", title: "Lecture Studio: Lecture In, Handouts Out", description },
  twitter: { card: "summary_large_image", title: "Lecture Studio: Lecture In, Handouts Out", description },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${nunito.variable} ${GeistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
