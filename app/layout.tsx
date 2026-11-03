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

export const metadata: Metadata = {
  title: "Lecture Studio",
  description: "Turn a recorded lecture into classroom-ready materials.",
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
