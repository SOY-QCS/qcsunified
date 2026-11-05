import type { Metadata, Viewport } from "next";
import { LabelLinker } from "@qcs/ui/web";
import "./globals.css";

export const metadata: Metadata = { title: "QCS Business Portal", description: "Book, track and manage QCS deliveries for your business" };
export const viewport: Viewport = { themeColor: "#df6518", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return <html lang="en-GH"><body>{children}<LabelLinker /></body></html>;
}
