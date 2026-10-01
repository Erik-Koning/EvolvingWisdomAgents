import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Wisdom Chat — an APG example",
  description:
    "A chatbot that learns about you and saves it into an Adaptive Prompt Graph, visualized live.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
