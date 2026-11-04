import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "QCS Operations",
  description: "QCS Ghana — Quality Courier Services",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en-GH">
      <body>{children}</body>
    </html>
  );
}
